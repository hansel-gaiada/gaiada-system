# IAM-HIER-01 — Hierarchy consolidation: the measured payoff + the plan

**Status:** PLANNED (this document is analysis + ticket decomposition; nothing here is built).
**Date:** 2026-08-10. **Owner direction (confirmed, not relitigated):** collapse the three
hierarchies to ONE — the org chart — per `2026-08-10-hierarchy-consolidation.md`.
**Parents:** `2026-08-10-hierarchy-consolidation.md` · `2026-08-10-iam-04-rollout-scan.md` ·
`2026-08-10-identity-rbac-program.md` (D-1..D-11) · `2026-08-10-iam-phase1-tickets.md`.
**Constraint honoured:** no code, policy, or migration changed by this ticket. The measurement
re-used the real detector's logic (`src/rbac/permission-arm-hazard-scan.test.ts`) ported
verbatim into a throwaway scratchpad script — same classifier, same Pattern-A/B scanners, zero
new heuristics. Live numbers are from read-only queries against `gda-aicenter` this session.

---

## 1. TASK 1 — the authoritative measurement

### 1.1 Method

The detector's four load-bearing functions (`classifyDerivedRoleExpr`, `parsePolicies`,
`scanPatternA`, `scanPatternB`, plus `selfScopeField` and the YAML loaders) were ported
byte-equivalent (TS types stripped) and run twice over `platform-nest/cerbos/policies/`:

- **BEFORE** — the current tree, unmodified.
- **AFTER** — simulated retirement: `team_lead` removed from every rule's `derivedRoles`;
  rules that thereby become empty dropped; the `team` kind (`resource_team.yaml`) deleted
  outright. Nothing else touched — `perm_*` roles, wildcards, every other rule byte-identical.

The BEFORE run **reproduces the IAM-04-ROLLOUT-SCAN register exactly** (61 kinds; SAFE 17,
EXEMPT 4, HAZARDOUS 40; the same per-kind mechanism attribution), which is the calibration proof
that the port is faithful.

### 1.2 Result

| Bucket | BEFORE | AFTER | Δ |
|---|---:|---:|---|
| Kinds in the estate | 61 | 60 | `team` deleted |
| EXEMPT (IAM-04c four) | 4 | 4 | — |
| **SAFE** | **17** | **34** | **+17 (doubles)** |
| **HAZARDOUS** | **40** | **22** | **−18** |
| — of which DEAD-GRANT SUSPECT | **22** | **0** | all 22 were the `team_lead` mechanism |
| Hazard rate (non-exempt) | 40/57 = **70%** | 22/56 = **39%** | |

**The coarse re-derivation is CONFIRMED, with one refinement.** Exactly **23 kinds name
`team_lead` in actual rules** (none comment-only among the rule-carrying set; the 3 extra grep
hits — `mcp_tool`, `report_admin`, `scope_signoff` — are comments/none-rule text), and all 23
carry it MIXED with a safe role (Pattern A). **18 of the 23 exit the HAZARDOUS bucket**: 17 move
HAZARDOUS → SAFE, and 1 (`team`) leaves the estate with its policy. The payoff is **not**
materially smaller than claimed — it is exactly the claimed 18, and the sequencing argument
stands.

Kinds moving HAZARDOUS → SAFE (17): `activity`, `client`, `client_contact`, `comment`,
`custom_field`, `deliverable`, `device`, `file`, `meeting_recording`, `member`, `notification`,
`org_structure`, `pm_project`, `pm_task`, `report_period`, `task`, `work_activity`.

The 5 `team_lead` kinds that STAY hazardous — `appraisal`, `integration_connection`, `project`,
`report_document`, `time_entry` — stay only for their independent **Pattern-B** (self-scope vs
unconditional) hazard, which retirement was never claimed to fix.

### 1.3 What the AFTER register is made of (why the residual 22 are cheap)

| Mechanism | Kinds | Mitigation class |
|---|---:|---|
| `module_staff`/`module_manager`/`module_approver` gate | 10 (`hr_case`*, `hr_record`, `agency_approval`, 7× `search_*`) | **confirm-reliable** — verification only, already done once for all 10 in the rollout scan; `hr_case` already mitigated |
| `group_executive` missing-company-branch | 6 (`automation_approval`, `pipeline_gate`, `pipeline_run`, `pipeline_stage`, `portal`, `scope_signoff`) | blocked on the TRAP-4 role-arm fix — **or dissolved by D-7's Phase-3 deletion of the role** |
| Pattern B only | 6 (`appraisal`, `checkin`, `integration_connection`, `project`, `report_document`, `time_entry`) | selective self-scoped mirroring — the known `hr_case` pattern |

**The expensive mitigation class disappears entirely.** BEFORE, 22 kinds needed the
handler-verified dead-grant exclusion treatment (rollout batches 4–7: one kind at a time, each
with a new pinned adversarial test). AFTER, **zero** kinds need it. Batch 4 (16 kinds) dissolves;
batch 5's three kinds halve to their Pattern-B half; batch 6 (`report_document`) loses its
hardest nuance — the dead-on-two-grains / live-on-one per-action split no longer exists; batch 7
(`team`) disappears. The already-shipped `perm_pm_task_*` exclusions become simplifiable (their
`team_lead` cross-checks reference a role that no longer exists).

### 1.4 One honest caveat: the hazard shape returns wherever `unit_lead` lands — by design, controlled by an authoring rule

The replacement role (§5, HIER-2) is attribute-dependent (it must read the resource's unit
ancestry), so the detector will classify it UNSAFE — correctly. Whether that re-creates
HAZARDOUS kinds depends entirely on authoring style: **Pattern A fires only on same-rule
mixing.** The SAFE bucket already contains the template (`service_assignment.read`:
`module_staff`/`module_manager` in their **own rule**, never mixed with scope-only roles).
HIER-2 therefore carries a binding authoring rule: *`unit_lead` always gets its own rule, never
joins a scope-only role list.* Under that rule, re-adding the lead tier to `report_document`
(which stays hazardous for Pattern B regardless) and `appraisal` changes **zero** bucket counts.
The detector re-derives everything fresh each run, so compliance is machine-checked forever.

---

## 2. Live scope usage — `record`, `project`, and the zeros re-confirmed

Read-only queries against `gaiada_platform` on `gda-aicenter`, 2026-08-10 (this session):

| Measurement | Value |
|---|---|
| `user_roles` by scope: `company` | **51** |
| `user_roles` by scope: `global` | **4** |
| `user_roles` by scope: `team` / `project` / `record` | **0 / 0 / 0** — these three scope types have never been granted; company+global is the entire live grant estate |
| `teams` / `team_memberships` | **0 / 0** |
| `org_unit_memberships` / `company_org_structure` | **19 / 2** |
| `roles` rows named `team_lead` | **0** (0091's seed is landed in-repo but not yet deployed — live cannot even grant the role today) |

### 2.1 `record` scope — VERDICT: vestigial, worse than `team`; retire in the same sweep

Complete usage inventory (code + policy + UI + data):

| Surface | `record` usage |
|---|---|
| Cerbos | **Zero.** No derived role and no rule anywhere references `scopeType == "record"` — a record-scoped grant matches nothing and confers nothing, at any tier |
| Writers | None in production code. Only the generic validator `admin/admin-identity.controller.ts:17` (`SCOPE_TYPES`) *accepts* it if an API caller supplies it |
| UI | **Not even offered** — `RoleManager.tsx:12`'s scope dropdown is `["company","global","team","project"]` |
| Readers | One defensive mention: `modules/reports/person-scope.ts:142` counts a `manager`/`team_lead` grant at `record` scope toward the `unit_scoped` tier — dead code given zero writers |
| Type unions | `rbac/principal.ts:19,34`, `testing/fixtures.ts:97` |
| Live rows | **0** |

`team` at least had a table, a controller, a derived role, and a policy. `record` has **none of
those** — it is a 0001 enum value that nothing ever implemented. Recommendation: **remove
`record` from the `scope_type` CHECK in the same migration that removes `team`** (HIER-1). If
per-record sharing is ever genuinely needed, the estate already has the correct mechanism and it
is not a role-grant scope: **relationship-class access** (IAM-04c's ruling — the 15
relationship pairs; `assistant_thread` ownership is the live precedent). A `user_roles` row per
shared record would be the wrong tool even if someone wanted the feature.

### 2.2 `project` scope — VERDICT: keep, but it is "supported, unused live"

- **Read for real:** `manager` and `member` derived roles carry a project branch
  (`derived_roles.yaml:43,53` — `g.scopeId == resource.attr.projectId || g.scopeId ==
  resource.attr.id`), and handlers genuinely populate the compared attributes (`core.controller.ts`
  passes `id: projectId` on project reads/updates; `reports.controller.ts:165` passes `projectId`
  for the project grain). A project-scoped `manager`/`member` grant would work today.
- **Offered:** RoleManager's scope dropdown includes it. `scope_id uuid` fits project ids.
- **Live:** zero grants ever made. Exercised only by tests (`cerbos.test.ts:45`).

Keep it: it is coherent, storable, Cerbos-readable end-to-end, and is the natural future home
for "external contractor scoped to one project" — and for cross-cutting squads (§4). But no
IAM-09/10 machinery should be built around it, and the permission-arm scope semantics already
(correctly) exclude it per IAM-04a's documented boundary.

### 2.3 A new end-to-end fact that strengthens the case (found this session)

The rollout scan classified `report_document.read_department` as `team_lead`'s one genuinely
reachable non-self grain. **At the database layer even that is unreachable.** The department
grain passes the ORG-CHART NODE ID as `teamId` (`reports.controller.ts:166` — `scopeRef` is a
free-form node id like `'d-hr'`), but `user_roles.scope_id` is **`uuid`** (0001) — a
`{scope_type:'team', scope_id:'d-hr'}` grant is **unstorable**. `reports-cerbos.test.ts`'s ALLOW
proof constructs the principal directly at the Cerbos layer, bypassing the DB — the covering
grant cannot exist in `user_roles`. (`person-scope.ts`'s header already records this exact
substrate fact as TR-25's reason for in-app narrowing.) So end-to-end, `team_lead` is
exercisable **only** on the `team` kind itself (the one place real team uuids flow) — against a
table with zero rows. The scan's policy-layer classification stands; the practical conclusion is
stronger: **every `team_lead` grant path except team-kind-self is dead, including the "live"
grain.** The real department narrowing that protects report data lives in `person-scope.ts`
(placement-derived subtree walk) and is untouched by retirement.

---

## 3. TASK 3 — the end-to-end write-path / compat sweep (nothing left to surprise anyone)

Every place a team-scoped grant or the team concept can be written, offered, or seeded — the
complete inventory the retirement ticket (HIER-3) executes against:

| # | Surface | What it does today | Fate |
|---|---|---|---|
| W1 | `core/teams.controller.ts` | Teams CRUD; **promote-to-lead mints `user_roles(team_lead, scope=team:<uuid>)`** (`:119`) and lazily creates the global `team_lead` roles row (`teamLeadRoleId()`, `:17-31`); demote deletes the grant | **DELETE the controller and its module wiring outright.** No deprecation period: the UI has **zero** calls to `/api/:t/teams*` (grepped — none), live tables are empty, and no other backend module imports it. `teams.test.ts` deleted with it |
| W2 | `admin/admin-identity.controller.ts:17` | `SCOPE_TYPES` accepts `team` and `record` on the generic role-assign endpoint | Remove both (add `org_unit`) — same change as the CHECK |
| W3 | `platform-ui/.../RoleManager.tsx:12` | Scope dropdown offers `team` | Remove (add `org_unit` with a unit picker, or defer the picker to Phase 4 and accept free-text like today) |
| W4 | `src/testing/personas.ts` (`:43-57,72-86,139-144`) | Seeds a REAL `teams` row + `team_memberships` lead row + a team-scoped `team_lead` grant for the `team_lead` persona | Rework to a `unit_lead` persona: seed a minimal org blob with one department node, an `org_unit_memberships` placement, and an `org_unit`-scoped `unit_lead` grant (placement matters — `person-scope.ts` narrows by placement). Its `personas.test.ts:74` device-DENY pin becomes the equivalent `unit_lead` pin |
| W5 | `src/seed/personas.ts` (`:36,107-124,168-184`) | Same shape for the login-able seed personas | Same rework as W4 |
| W6 | `migrations/0091_iam_02d_ungrantable_roles.sql` | Seeds the global `team_lead` roles row (undeployed live) | Retirement migration deletes the roles row + any `role_permissions` bundle rows + any grants (all counts asserted, expected 0 grants) |
| W7 | `migrations/0094` bundles + `role-permission-bundles.json` + `scripts/generate-role-bundles.mjs` (`REAL_ROLES`) | `team_lead` bundled (60 pairs) | Bundle rows deleted; JSON + generator role list regenerated; the parity suite's own hand-maintained `REAL_ROLES` (already-flagged drift #5) shrinks by one |
| W8 | `permission-catalog.json` + `0093` | 4 keys: `core.team.{create,read,update,delete}` | Stamp `deprecated_at` in the `permissions` table and remove from the catalog JSON + policy matrix together (the three-way drift chain must move in one commit) — catalog 230→226, grantable 215→211 |
| W9 | Policies: 23 `resource_*.yaml` + `derived_roles.yaml` | `team_lead` in rules; the `team_lead` derived role; `resource_team.yaml`; the 5 `perm_pm_task_*` `team_lead` exclusions | Sweep: remove the name from 22 kinds' rules, delete `resource_team.yaml`, delete the derived role, simplify the 5 `perm_pm_task_*` exprs. ⚠ Cerbos restart required (no hot reload — standing memory) |
| W10 | UI mirror: `platform-ui/src/lib/rbac.ts` (`Role` union `:25`, `ROLE_CAPS` `team_lead:` `:317`, `scopeCovers` comments), `rbac-capability-map.ts` | Gap-2's `team_lead` sweep | Remove; capability-axis parity tests regenerate |
| W11 | Type unions + narrowing: `rbac/principal.ts:19,34`, `testing/fixtures.ts:97`, `modules/reports/person-scope.ts:117,142` | `team`/`record` in unions; `team_lead` in `UNIT_SCOPED_ROLES`; team/record in the tier condition | Replace with `org_unit` / `unit_lead` (keep `project` in the person-scope condition — behaviour-preserving for project-scoped `manager`) |
| W12 | Tests pinning `team_lead` semantics | `pm-adversarial-authz.test.ts`, `cerbos-permission-dual-match.test.ts`, `cerbos.test.ts` (team cascade), `reports-cerbos.test.ts:121` (the Cerbos-layer dept ALLOW), `cerbos-webdev-matrix.test.ts:137,178`, `personas.test.ts:74`, `teams.test.ts` | Each updated/deleted per its role; enumerated in HIER-3's spec below. ⚠ **The hazard-scan detector's own tests break on retirement and must be co-updated** (see below) |
| W13 | Tables `teams`, `team_memberships` (0001) | 0 rows live; no FK from any other table (files/comments target kinds do not include team) | `DROP TABLE` in the retirement migration, after asserted-zero counts |

⚠ **W12 detail — the detector self-references the retired concept.**
`permission-arm-hazard-scan.test.ts`'s control-kind assertion requires `pm_task` to be flagged
hazardous (it moves to SAFE after retirement) and PART 4's synthetic teeth-proof constructs its
hazard from `team_lead` (whose derived role — the classifier's input — is deleted). The
retirement ticket must swap the controls (`hr_case` stays valid; add `time_entry` or
`integration_connection` as the second) and re-base the synthetic fixture on a surviving unsafe
role (`client` is the natural choice). This is a co-update inside HIER-3, not a change to the
detector's logic.

**No data migration exists because there is no data** — but the retirement migration still
carries defensive, count-asserted deletes (grants at `team`/`record` scope, `team_lead`
roles/bundle rows) so a surprise row fails loudly instead of silently surviving a `DROP`.
The RLS zero-row backfill trap does not apply: `user_roles`, `roles`, `role_permissions`,
`permissions` carry no RLS (verified in the 0092 report), and the dropped tables need no reads.

---

## 4. What is lost by deleting `teams` — and how to express it later

`teams` allowed a grouping **orthogonal to the reporting hierarchy** — a cross-department
project squad, a task force, a committee. `org_unit` is strictly the reporting tree. Deleting
`teams` deletes the unused *implementation*; the *capability*, if ever wanted, has three homes
that already exist — in order of fit:

1. **A delivery squad is a `project`** — `project` scope survives (§2.2), `manager`/`member`
   project-scoped grants already cascade in Cerbos end-to-end, and `pm_task_assignees` already
   supports poly-assignees. A "squad" that exists to deliver something IS a project with members;
   this is the answer for ~90% of what `teams` was for.
2. **A committee/loan is a non-primary `org_unit_membership`** — 0055 deliberately lets
   non-primary rows overlap freely precisely so secondary attachments exist WITHOUT touching the
   primary reporting line. A standing cross-cutting body can be a unit node placed anywhere in
   the chart with non-primary members from other departments.
3. **A durable named group with its own authz surface is a relationship-granted kind** — the
   `chat_group` kind is the live precedent (membership rows, not role grants). If someone someday
   needs "task force X may see resource Y," mint it then, as a kind + relationship table, with a
   deliberate policy — not by resurrecting a generic scope that took five years to reach zero rows.

Two things ARE genuinely lost and are acceptable: the `parent_team_id` nested-team tree (it
duplicated the org chart's own nesting — that duplication is the disease being cured), and the
ability to hand someone a lead grant over an ad-hoc group with zero org-chart presence (expressible
via 1 or 3 above the day it is wanted). **Conclusion: the consolidation is right.** I looked for a
reason to call it wrong — the strongest candidate was orthogonal grouping, and the estate already
holds three better-fitted mechanisms for it. Carrying a 0-row parallel hierarchy named in 23
policies as insurance against a hypothetical is exactly how the 70% hazard rate happened.

---

## 5. TASK 2 — the consolidation plan (tickets)

Tier legend per the army standard; **model·effort** recommended per ticket, seat default unless
flagged. Migration numbers are claimed at implementation time per `migrations/README.md` rule 5 —
observed head is `0099`, so the first implementer re-checks and takes the next free slot.

### HIER-1 — `org_unit` scope: `team`'s replacement in the grant substrate (reshapes IAM-08)

**Tier:** senior-db. **Model: opus·medium** — a type change on the estate's core grant table
(`user_roles`) where one missed uuid-comparison surfaces as a runtime authz 500; a cheap first
pass that misses one would force a full re-sweep.

- `scope_type` CHECK becomes `('global','company','org_unit','project')` — **adds `org_unit`,
  removes `team` AND `record`** (0 rows at both, count-asserted in-migration).
- **Widen `user_roles.scope_id` `uuid` → `text`.** This is the load-bearing DDL decision, and it
  is forced by substrate reality, not preference: org-unit node ids are free-form text
  (`'d-hr'`, `'dv-web'` — 0055/0029 convention), and `person-scope.ts`'s header already records
  that a unit grant is unstorable today for exactly this reason. Alternatives rejected:
  eager-materializing `org_units` rows to keep uuid grants creates a permanent
  text↔uuid translation seam against `org_unit_memberships.unit_node_id`, the closure table, and
  the blob (all of which speak node-id text), plus a node-lifecycle problem `org_units`' lazy
  design deliberately avoids; a parallel unit-grant table forks the principal/Cerbos payload
  shape every consumer reads. Guard the typing loss with a per-scope shape CHECK
  (`scope_type IN ('company','project') → scope_id ~ uuid-regex`; `org_unit` → non-empty text;
  `global` → NULL, the 0092 partial-unique index unchanged).
- Acceptance ("done when"): migration applies on a fresh DB and on a copy of live; full-repo grep
  for `scope_id` reviewed with every comparison site listed in the ticket report; existing suites
  green; a new test proves an `org_unit`-scoped grant round-trips through
  `assemblePrincipal()` → `attr.grants` verbatim.
- Depends: nothing. **This absorbs IAM-08** (see HIER-4).

### HIER-2 — `unit_lead`: the unit-scoped lead role + subtree cascade (reshapes IAM-09/10)

**Tier:** senior-be. **Model: opus·medium** — security-critical cascade semantics: an over-wide
ancestry attribute silently widens a dept head's reach across the subtree boundary; this is the
one ticket where a subtle mistake is an access-widening, not a test failure.

- **Naming:** `unit_lead` (recommended — "lead of an org unit"; `dept_lead` misnames division
  leads). Seeded global roles row + bundle in the same change (the sixth-time-lucky lesson:
  never a code-known role without a row).
- **Cascade mechanism (IAM-10's design, made concrete):** the RESOURCE carries its unit ancestry;
  the grant matches any ancestor. Contract sketch:

  ```yaml
  - name: unit_lead
    parentRoles: ["user"]
    condition:
      match:
        expr: >-
          has(request.resource.attr.unitAncestors) &&
          request.principal.attr.grants.exists(g, g.role == "unit_lead" &&
            g.scopeType == "org_unit" && g.scopeId in request.resource.attr.unitAncestors)
  ```

  `unitAncestors` = `[resource's unit node id, …its ancestors…]`, computed by the handler from
  IAM-09's closure table (one indexed query; keyed on **text node ids**, per HIER-1). A grant at
  a department therefore covers every division beneath it — cascade-down falls out of ancestry
  containment with no per-request tree walk. Fail-closed by construction: a node absent from the
  live tree (deleted unit, stale grant) yields no ancestry containing it, so an orphaned
  `unit_lead` grant covers nothing; HIER-5 adds an orphan-grant sweep to surface them.
- **Resolver reuse — build NO new resolver:** `dept-resolution.ts` already does pure, unit-tested
  as-of-date person→unit resolution (`resolveMembershipAsOf`/`resolveDepartment`), and
  `person-scope.ts::collectUnitSubtree` already does the subtree walk. HIER-2 wires, never
  re-derives: handlers get ancestry from the closure; person-axis narrowing keeps
  `person-scope.ts` as THE boundary (its header's reasoning — Cerbos cannot do as-of dates —
  remains true and is untouched).
- **`person-scope.ts` changes:** `UNIT_SCOPED_ROLES` = `{"manager","unit_lead"}`;
  `loadLedUnitScope()` gains a grant-derived source — the union of the caller's `org_unit`-scoped
  `unit_lead` grant scopeIds, each expanded by `collectUnitSubtree` — alongside (not replacing)
  the existing placement-derived path for `manager`. Leadership becomes explicit and
  grant-auditable, which is D-3's point.
- **Binding authoring rule (the §1.4 guard):** `unit_lead` always occupies its OWN policy rule,
  never mixed into a scope-only role list. The hazard detector enforces the consequence
  automatically forever.
- **Initial landing surface (minimal, handler-backed only):** `resource_report_document`
  (`read_person`/`read_project`/`read_department` — its own separate rule beside the existing
  `manager` rule; `reports.controller.ts:166` renames the passed attr `teamId` → `unitAncestors`
  with the closure lookup) and `resource_appraisal`'s dept-lead rule. Nowhere else until a
  handler actually passes unit ancestry — landing the role in policies no handler feeds would
  recreate the dead-grant pattern this program just spent a day measuring.
- Acceptance: adversarial suite proving (a) a `unit_lead` at dept `d-web` reads a `dv-frontend`
  report and NOT a `d-seo` one, (b) as-of-date transfer honoured (fact dated before a transfer
  resolves to the old unit — reuse `dept-resolution.test.ts`'s matrix shape), (c) a
  company/global-scoped `unit_lead` grant confers nothing, (d) an orphaned-node grant confers
  nothing. Cerbos restarted as part of the run.
- Depends: HIER-1, IAM-09 (closure). If IAM-09 has not landed, HIER-2 builds the closure as its
  first commit (it was already planned; only its key type changes — text node ids).

### HIER-3 — retire `team_lead`, `team` scope, `teams`, `team_memberships`, the `team` kind

**Tier:** medior (mechanical — every touch point is enumerated in §3's W1–W13), with senior-be
review. Seat default model. Large diff, zero judgment calls left.

- Executes §3's table verbatim: controller + tests deleted (W1), validators/UI scope lists (W2/W3),
  personas reworked to `unit_lead` (W4/W5), roles/bundles/catalog cleanup (W6/W7/W8), the 23-file
  policy sweep + derived-role deletion + `perm_pm_task_*` simplification (W9), UI mirror (W10),
  type unions + person-scope (W11), test co-updates incl. the detector's control kinds + synthetic
  fixture (W12), `DROP TABLE` migration with count-asserted defensive deletes (W13).
- Acceptance: repo-wide grep for `team_lead|team_memberships|scope_type.*team` returns only
  historical docs; `cerbos compile` clean + container restarted; full platform-nest + platform-ui
  suites green; the IAM-02b parity suite green (proving zero authorization decisions changed —
  every removed reach was unreachable); hazard-scan suite green with its new controls.
- Depends: HIER-2 (replacement exists before deletion, so personas/tests/policies swap atomically,
  not in a hole).

### HIER-4 — rewrite IAM-08/09/10 in the program doc (they were planned as additions)

**Tier:** junior (seat default) — text edits fully specified here: IAM-08 is absorbed by HIER-1
(replacement, not a fourth sibling scope; `record` removed in the same breath); IAM-09 unchanged
in substance but keyed on text node ids and explicitly double-duty (subtree queries AND authz
ancestry); IAM-10 becomes HIER-2's mechanism + the own-rule authoring rule; IAM-11/12 (positions,
reconciler) untouched — positions attach role sets that the reconciler materializes as
`org_unit`-scoped grants, which is exactly the substrate HIER-1/2 provide. Also record the
IAM-04c sequencing flag interaction: none (owner envelope unaffected).
- Depends: HIER-1/2 specs blessed (can draft in parallel).

### HIER-5 — re-scan, re-baseline, orphan sweep

**Tier:** qa (seat default). Re-run the detector post-HIER-3, refresh
`2026-08-10-iam-04-rollout-scan.md`'s register (the AFTER table in §1.2 becomes the new
baseline), verify the predicted 34/22/0 landed, and add the orphaned-`unit_lead`-grant sweep
(HIER-2's fail-closed note) as a standing drift test.
- Depends: HIER-3.

### Sequencing against IAM-04-ROLLOUT (the measured justification)

```
now ──► rollout batches 1–3 (17 SAFE kinds + 9 confirm-reliable + checkin)   ← team_lead-independent, proceed anytime
   ╲
    ╲── HIER-1 ─► HIER-2 ─► HIER-3 ─► HIER-5 ─► rollout resumes over the cleaned estate:
                     │                            6 Pattern-B kinds + report_document (Pattern-B half only)
                     └─ HIER-4 (parallel)         + 6 group_executive kinds (still blocked on the TRAP-4
                                                    role-arm fix or D-7 deletion — unchanged either way)
```

**Do NOT start rollout batches 4–7 before HIER-3 lands.** The measurement is the argument: those
batches are 18 kinds of one-at-a-time, adversarially-pinned exclusion work whose entire subject
matter is deleted by HIER-3 — 16 kinds' worth dissolves outright, 3 halve, the hardest per-action
nuance (`report_document`) evaporates, and `team`'s delicate batch-7 case disappears. Paying the
70% rollout cost first would mean carefully mitigating dead grants for a concept with zero rows,
zero storable grants, zero UI, and a scheduled deletion.

---

## 6. Open questions that genuinely need the owner

1. **Bless `unit_lead` as the role name** (alternatives: `dept_lead`, `org_unit_lead`). Cheap
   now, expensive after policies/bundles/UI ship it.
2. **Bless removing `record` from the scope CHECK alongside `team`** (§2.1). Zero rows, zero
   readers, not UI-offered; the future per-record need is relationship-class by IAM-04c's own
   ruling. Keeping it dormant costs a permanent "what is this?" in every future audit.
3. **Bless the `scope_id uuid → text` widening** (HIER-1) — core-table DDL; the alternative
   (eager `org_units` uuid anchors) was evaluated and rejected above, but this is the one
   decision that is expensive to reverse.
4. **Timing of `appraisal`'s `unit_lead` adoption:** with `team_lead` retired, the dept-lead
   appraisal tier is `manager`-only until HIER-2 lands there. Zero live holders are affected
   (nothing storable ever reached it). If the owner wants a dept-head appraisal tier live sooner,
   HIER-2's landing surface already includes it; confirm that is wanted now rather than at
   IAM-11 (positions), which would grant it automatically to dept-head positions.
