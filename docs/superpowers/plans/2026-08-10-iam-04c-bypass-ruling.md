# IAM-04c — Ruling on the superadmin/owner wildcard bypass

**Status:** RULING ISSUED — 2026-08-10. Analysis only; no code, policy, or migration changed by
this ticket. Follow-up tickets PLANNED (§7). This ruling governs the Phase-3 `owner` envelope
(IAM-14) and the D-9 no-self-escalation invariant, so it outlives Phase 1.

**Parents:** `2026-08-10-iam-phase1-tickets.md` (IAM-04c) ·
`2026-08-10-identity-rbac-program.md` (D-2, D-5, D-6, D-8, D-9) ·
`2026-08-10-iam-01a-02a-analysis.md` §6 Ruling 3 · `2026-08-10-permission-catalog.md` §5.

**Evidence base (verified in source this session, not restated from docs):** the 56 wildcard
rules (56 files, one rule each; the 57th grep hit is a comment in
`resource_automation_approval.yaml:32`); all four exempt kinds' policies
(`resource_assistant_thread.yaml`, `resource_assistant_memory.yaml`, `resource_agent_run.yaml`,
`resource_mcp_tool.yaml`) use base `roles:` only — **zero `derivedRoles` rules exist on any exempt
kind**; `resource_rollup.yaml` (wildcard-less, not exempt — its whole policy is the elevated
grant); `derived_roles.yaml` (the `platform_admin` tier predicate lives in exactly one place);
`src/rbac/cerbos.ts:34` (`roles: ["user"]` always — no platform principal can carry
`hub_caller`); `src/rbac/role-permission-parity.db.test.ts` (see §5 — a real defect found);
`src/rbac/cerbos-assistant.test.ts` (see §5 — a second gap found); migration 0093's
`role_permissions_reject_relationship` trigger + IAM-03's dual-layer exclusion proof.

---

## 1. THE RULING (verdict)

**The bypass stays a per-kind wildcard RULE in Cerbos policy, keyed to the superadmin tier. No
`*` permission — global or per-kind (`<domain>.<resource>.*`) — ever enters the permission
catalog, at any phase.** The permission catalog is the vocabulary of *delegatable* authority:
every entry is a concrete, role-assignable primitive mapping 1:1 to one Cerbos `(kind, action)`
pair (0093's CHECK constraint already enforces exactly this shape). The superadmin bypass is
deliberately *not delegatable* — D-6 makes superadmin an appointable **tier**, and D-9's
two-person rule makes the appointment path the ONLY door to that power. Reifying the bypass as a
grantable `*` permission would open a second door through every role-authoring surface (Phase-4
UI, migrations, seeds, company-local authoring under D-5, or a compromised authoring path):
one accidental or malicious `role_permissions` row would equal total compromise, silently routing
around the two-person rule. It stays structure, not data.

Corollaries, each argued below: the seeded `platform_admin` bundle (215 rows, 0094) remains a
**regenerated audit mirror**, never an enforcement source (§2); `owner` is expressed as a
permission-native bundle that inherits the 15-pair exemption **structurally**, stating zero
denials (§3); the bypass stays per-kind — 56 rules is 61 explicit decisions, not duplication
(§4); the header comment on `assistant_thread` is necessary but **not sufficient**, and the two
automated guards everyone believes exist are today **both unable to fire** on the exact
"restore for consistency" mistake — a new test is required (§5); Ruling 3's three-class table is
revised to a **binary grantability class plus a three-value `mechanism` axis** (§6).

---

## 2. Q1 — Why a rule, not a `*` permission

Both options were weighed against the three criteria in the ticket. The rule wins on all three.

### 2.1 Auditability — "what can this role do?"

- **Every role's answer must be a concrete list.** Library roles: read the bundle. Superadmin:
  the 0094-seeded 215-row bundle **stays**, redefined as a *generated artifact* — regenerated
  from wildcard-expanded policy exactly as 0094 derived it, never hand-edited, never the
  enforcement path for the tier. IAM-02b's parity suite already pins bundle == expanded policy,
  so the audit answer and the enforcement truth are machine-locked to each other. A `*`
  permission gives the opposite: the bundle would say `*`, which is a pointer, not a list — its
  expansion changes every time the catalog grows, so "what could this role do on 2026-06-01" is
  no longer answerable from the grant record. Under D-9's immutable-audit requirement that is
  disqualifying on its own.
- **Enforcement-side truth stays single.** If the bundle were the enforcement source for
  superadmin, new actions on a kind would not flow to the tier until a re-seed — the mirror-lag
  drift problem this program exists to kill, relocated to the most dangerous role. As a rule,
  new actions on a bypass-covered kind flow automatically; `resource_automation_approval.yaml`'s
  OQ-1 note is the recorded precedent (`decide`/`retry` were covered by the existing `*` rule;
  adding a redundant explicit rule was rejected because a redundant pair "would invite someone to
  later 'tidy' one of the two and change behaviour").

### 2.2 D-9 no-self-escalation and the two-person rule

- Today, acquiring bypass power requires exactly one act: a global `platform_admin` grant in
  `user_roles` — the single path IAM-13/16 wraps in appointment + two-person control. A grantable
  `*` would create a **second acquisition path** through `role_permissions`, whose write surface
  is enormously wider (every role-authoring flow, every seed, every migration) and, after
  Phase 4, partly delegated (D-5 lets company_admin/owner author company-local roles). The
  no-self-escalation invariant (IAM-17) would have to police wildcard-injection into every bundle
  a principal holds or can edit — an open-ended obligation, versus policing one grant row.
- **Ceiling algebra breaks.** D-5 bounds company-local authoring by "that company's entitled
  permission set" — a plain subset test over concrete keys. `*` has no stable subset semantics:
  every ceiling check, every UI filter, every API validation must special-case it, and one missed
  special case grants everything. Keeping the catalog 100% concrete keeps ceiling enforcement a
  decidable set inclusion with no privileged tokens.
- Convenience is already served without a wildcard object: permission **groups** (IAM-01b-3, 75
  groups) expand to concrete keys at authoring time, so bundles are always concrete. Nothing a
  `*` permission would buy is missing.

### 2.3 Accident and compromise surface

A `*` catalog entry must be simultaneously present (so it can be held) and excluded from every
authoring list, entitled set, and grant path except one. The codebase's own history says this
class of "present but must never be used" invariant fails: the catalog work needed a CHECK
constraint **and** a trigger **and** a query-level filter **and** a parity test to keep 15
relationship pairs out of bundles. Recreating that entire defense stack around a deliberately
grantable-shaped `*` object — with far worse blast radius — is strictly worse than not minting
the object. The bypass-as-rule alternative needs zero of it: there is nothing to grant.

### 2.4 What the rule looks like across phases

- **Now (Phase 1, IAM-04a/04b concurrent):** untouched. The instruction to leave every `*` rule
  alone is hereby confirmed as the **permanent disposition, not a temporary hold**. The `*` rules
  are excluded from the permission-matching migration in every phase; IAM-30's Phase-7 sweep
  migrates business rules and leaves the tier rules. Likewise, no permission-matching rule may
  ever be added to the four exempt kinds' policies (there are no permissions to match — the 15
  are not in the catalog).
- **Phase 3 (D-6 collapse, IAM-13):** cheap by construction. All 56 rules reference the
  `platform_admin` **derived role**; its predicate lives in exactly one place
  (`derived_roles.yaml:10-16`). Renaming/collapsing the tier is a one-definition change plus the
  principal-assembly side — not a 56-file sweep. The 8 wildcard-or-elevated rules that also name
  `group_executive` (`company`, `contract`, `invoice`, `device`, `knowledge_source`, `pm_project`,
  `pm_task`, plus `rollup`'s explicit rule) lose that name in IAM-15's sweep; the tier term stays.
- **End state (Phase 7):** exactly one role-name-matched construct family survives — the
  platform's fixed principal classes (`user`, `hub_caller`, `client`, and the superadmin tier).
  All delegatable business authority is permission-matched. That is a clean, defensible boundary,
  and it is consistent with D-2's intent: D-2 exists so *roles can be data*; the superadmin tier
  is by definition (D-6, tier table: "System tier … Not a business role") not data.

---

## 3. Q2 — How `owner` (D-8) inherits this

**`owner` gets NO wildcard rule, NO per-kind policy rules at all. It is the first
permission-native role: a platform-managed bundle over the grantable catalog, scoped per owned
company, enforced exclusively through the IAM-04 permission-matching path.**

### 3.1 Why not a second wildcard (or a per-kind rule sweep)

- A scoped owner-wildcard would be a second bypass lattice: 56 more rules, each carrying a scope
  condition, encoding a broad business role in policy. That is architecturally
  `group_executive` again — and Finding B measured where that ends: a policy-encoded broad
  business role drifted to 118/230, weaker than `company_admin`, wrong in both directions, and
  D-7 is deleting it. The lesson is direct: **broad business roles encoded as per-kind policy
  rules drift; bundles are diffable and provable.** The highest-risk role in the system (real,
  non-technical people — D-8) must be the most provable one, not the second policy lattice.
- "Everything business" is not "everything on these kinds": the envelope excludes
  platform/system controls *within* kinds owner otherwise reaches (e.g. owner likely reads
  `company` but must not flip `compliance_gate.update`-class controls). Wildcards cannot express
  action-level exclusions without DENY rules — and this repo's **zero-`EFFECT_DENY` invariant**
  (measured, load-bearing; see §4.2) must hold.

### 3.2 The exemption from the 15 is structural, stated as an inherited invariant

Because owner is a bundle and the 15 are not grantable catalog entries, owner **cannot** reach
them, through four independent, already-verified layers:

1. **Catalog class boundary** — the 15 carry `class: "relationship"`; they are not in the
   grantable set bundles are built from (IAM-01b, machine-verified).
2. **DB trigger** — 0093's `role_permissions_reject_relationship` makes inserting one into any
   bundle structurally impossible (DEV-VERIFIED).
3. **Resolution-time filter** — principal permission resolution selects `class='grantable'`
   only; IAM-03 proved this layer independently *with the trigger deliberately disabled*
   (DEV-VERIFIED).
4. **Policy-side absence** — the four exempt kinds' policies contain zero `derivedRoles` rules
   and will contain zero permission-matching rules (§2.4); there is no rule an owner-held
   permission could ever satisfy (verified this session).

**Consequently the owner envelope document (IAM-14) must state the exemption as one sentence
citing this ruling — "owner is a grantable-catalog bundle; the 15 ungrantable pairs are
unreachable by construction (IAM-04c §3.2)" — and NOT as 15 enumerated denials.** An enumerated
denial list would immediately become a fifth, hand-maintained copy of the boundary that can
drift; the four structural layers cannot.

### 3.3 The envelope as a generated exclusion

The owner bundle is **generated by exclusion**: `all 215 grantable` minus a named
**platform/system-control exclusion list**, regenerated from the catalog per release, committed,
and diff-reviewed (the IAM-05b pattern: generate the proof, review the diff). This keeps
"everything business" true as the catalog grows — a new business permission lands in owner's
bundle by default **via a reviewed diff**, never silently — while every widening or narrowing of
the envelope is a visible, attributable change. The exclusion list *is* the owner-envelope
contract. Membership of that list is an **owner decision at IAM-14** (seed the discussion from
the catalog's S5 rubric + `sensitive` flags; obvious candidates: `core.compliance_gate.update`,
`core.identity_link.*`, `core.service_assignment.{reconcile,relink}`, `core.company.delete`;
obvious tensions to decide: `core.rollup.read` for a holding-level owner, `core.user.*`).

**Hardening recommendation (owner may veto):** the owner bundle is system-managed data —
mutable only via the release process (migration/seed + PR review + deploy), **not** through any
runtime role-authoring UI, including superadmin's global-library UI. Envelope changes to the
highest-risk role then get two-person review by construction and D-9 alerting has a fixed,
narrow write path to watch. Company-local roles owners author (D-5) are unaffected; this covers
only the owner role's own definition.

### 3.4 Sequencing consequence (flag for the program plan)

Because owner is permission-native and appears in **no** role-name rule, **IAM-14 depends on the
IAM-04 permission-matching path covering every kind in owner's envelope — not just the two
IAM-04b pilots.** Phase 3's plan must either (a) schedule the IAM-30 policy sweep for the
business kinds *before* IAM-14 activates owner, or (b) accept a staged owner rollout kind-by-kind
behind the dual-match. Option (a) is cleaner and is the recommendation; either way the program
doc's Phase 3/Phase 7 ordering needs this dependency written in. This is the concrete reason
IAM-04c "governs Phase 3's owner envelope".

---

## 4. Q3 — Per-kind stays. 56 rules is 61 decisions, not duplication

### 4.1 A single cross-cutting bypass is not expressible where it would be safe

- **Cerbos structurally forces per-kind:** rules live inside per-resource policies; only derived
  roles and variables are shared. There is no cross-resource rule mechanism. The nearest Cerbos
  construct — a `principalPolicy` per appointed superadmin — is rejected: appointment would
  mutate the policy set at runtime (colliding with the documented no-hot-reload trap: an
  appointment would require a PDP restart), and exempting the 15 inside it would require
  `EFFECT_DENY` rules, breaking the repo's zero-DENY invariant (§4.2).
- **The only true "one rule" is an app-code short-circuit** (`if (isSuperadmin) allow` before
  Cerbos). Rejected: it bypasses Cerbos decision audit exactly where D-9 demands immutable audit
  of elevated actions; it breaks PlanResources/D16 list filtering, which would need a parallel
  code path; and it needs its own exemption list — a second, driftable copy of the 15 living in
  code while the truth lives in policy. The codebase already has precisely one such code gate
  (`admin/elevated.ts` `isElevated()`, used by a handful of admin controllers), and the catalog
  work had to special-case its single catalog-visible effect (`agent_run:read`) as its own
  mechanism — evidence that code gates are exceptional and expensive to reason about, not a
  pattern to generalize.

### 4.2 Exemption by absence beats exemption by DENY (why per-kind is load-bearing)

The 15 exemptions are expressible **only** because the bypass is per-kind: an exempt kind simply
carries no bypass rule, and Cerbos's deny-by-default does the rest. This is fail-closed — the
exemption cannot be lost by deleting a line, only by adding one, and adding is what review
catches. The repo's measured **zero-`EFFECT_DENY`** property is what makes every policy file
locally reviewable: any single rule can only *widen* access, so reading one file suffices to
review it. Any cross-cutting bypass design flips the 15 into DENY-based exemptions that must
outrank every future ALLOW forever, and makes every review non-local. The 56th wildcard rule is
therefore not clutter to be tidied — each of the 61 kinds made an explicit decision, five said
no, and one (`rollup`) said "yes, expressed as my entire policy". Preserve exactly this.

### 4.3 The authoring rule this implies

**Every new resource policy must answer the bypass question explicitly:** carry the tier `*`
rule (the default), or be added to the exempt-kind registry with a header rationale in the
policy file (the `assistant_thread` precedent). The registry is a checked-in constant (§5.3);
editing it is an owner-sighted act. This line goes into the IAM-07a contract doc's policy
authoring section. Style rule alongside it: prefer the `*` form over enumerating actions for the
tier rule, so new actions flow without inviting the redundant-pair drift OQ-1 documented.

---

## 5. Q4 — A comment is not sufficient, and the guard everyone believes exists CANNOT FIRE

This section reports two defects found while verifying the existing guards. Both are stated
precisely so the follow-up tickets are mechanical.

### 5.1 🔴 Finding G1 — IAM-02b's relationship-leak assertion is dead code on the Cerbos side

`src/rbac/role-permission-parity.db.test.ts` claims (header, lines 13–18) that a wildcard
restored on `resource_assistant_thread.yaml` "would immediately show up here". **It would not.**
`computeCerbosCoverage()` filters relationship-class pairs out of every role's derived coverage
*before* any test reads it:

```ts
// role-permission-parity.db.test.ts:197
if (classByPair.get(pairId) !== "grantable") continue; // relationship pairs: never role-reachable
```

Add `- actions: ["*"] / derivedRoles: ["platform_admin"]` to `resource_assistant_thread.yaml`
and trace it: the wildcard expands to the kind's 9 actions, all classed `relationship`, all
skipped — `platform_admin`'s computed coverage is unchanged, the per-role parity test passes,
the full-matrix test passes, and the dedicated "none of the 15 is reachable by ANY role" test's
`cerbosLeak` arm compares against the same pre-filtered coverage, so it is **vacuous by
construction** — it verifies the filter works, not that the policies are clean. (The `bundleLeak`
arm is real: the DB could leak if the trigger were dropped. Only the Cerbos arm is dead.)

### 5.2 🔴 Finding G2 — the live-PDP assistant suite never tests `platform_admin`, and its action list is stale

`src/rbac/cerbos-assistant.test.ts` asserts DENY for `company_admin` and `group_executive` — but
has **no `platform_admin` case at all**, which is precisely the role the wildcard rule would
grant. Additionally its `THREAD_ACTIONS` (line 33) lists 7 actions — `handoff` (ASST-21) and
`confirm_write` (ASST-23) were added to the policy later and never joined the test matrix.

**Net position today: nothing automated fires on the exact mistake the `assistant_thread` header
begs against.** The layers that do exist and hold: the header comment (advisory), the 0093
trigger + IAM-03 filter (protect bundles, not policies), and the catalog's class marking
(inert until IAM-07b exists). IAM-07b — the pinned drift chain — is still unclaimed.

### 5.3 The required guard: the 215-boundary pin (this is the test, and IAM-02b's file is the right neighborhood but the wrong derivation)

One static test, using an **unfiltered** re-parse of the policies (the parity suite's parser is
reusable; its coverage function is not, per G1):

1. **Exempt-kind registry** — a checked-in constant: `assistant_thread`, `assistant_memory`,
   `agent_run`, `mcp_tool`. For each: assert the kind's policy contains **zero rules using
   `derivedRoles`** (strictly stronger than "platform_admin reaches nothing" — it also catches a
   restored `company_admin` rule, which the header forbids equally). All four satisfy this today
   (verified this session: base `roles:` only).
2. For **every other kind**: assert `platform_admin`'s expanded reach equals the kind's full
   action universe. This passes for the 56 wildcard kinds *and* for `rollup` (explicit rule over
   its 1-action universe) — the test pins the **semantics** (tier reaches everything on
   non-exempt kinds), not the syntax, so rollup needs no special case.
3. Teeth proof in the ticket's acceptance: temporarily add a `platform_admin` wildcard to
   `resource_assistant_thread.yaml` → test red; temporarily delete a wildcard from one business
   kind → test red; restore → green.

This single test catches: wildcard restored on an exempt kind, any derived-role rule added to an
exempt kind, the bypass forgotten on a new kind, superadmin quietly excluded from an action on a
non-exempt kind, and a new kind added without deciding the bypass question (§4.3). It is static
(no PDP, no restart trap, runs everywhere). **Home:** a sibling test beside the parity suite in
`src/rbac/` — same infrastructure, different derivation — promoted into IAM-07b's pinned chain
when that lands. IAM-02b's *file* is the right neighborhood; its *coverage function* must not be
reused for this (G1).

Belt-and-braces at the PDP layer (because static parsing cannot see CEL/evaluation subtleties):
extend `cerbos-assistant.test.ts` with global-scope `platform_admin` DENY cases across all 9
thread + 4 memory actions, and add the 2 missing actions to its matrix. Follow the documented
restart discipline in the acceptance steps.

And fix G1's file honestly: correct the over-claiming header and either delete the vacuous
`cerbosLeak` arm or repoint it at the new unfiltered derivation. A test that documents itself as
a guard it is not is worse than no test.

---

## 6. Q5 — Ruling 3's table: keep the boundary binary, name the mechanism as its own axis

**Yes, revise — but not into three top-level classes.** The load-bearing invariant is binary:
*can any role ever hold this?* Everything downstream keys on that single bit (0093's CHECK +
trigger, 0094's exclusion, the resolution filter, the parity suite, module-declaration
validation, the authoring UI). Splitting the class axis three ways would force every consumer to
enumerate mechanisms it does not care about and would invite a fourth class later. The mechanism
matters for a different audience — maintainers and the Phase-3 envelope doc — so it becomes a
**sub-axis on the ungrantable class**:

| Class (binary) | Mechanism | Pairs | Grant path | What guards it |
|---|---|---|---|---|
| grantable | — | 215 | role bundles over `user_roles` | catalog + parity suite + boundary pin |
| ungrantable (bypass-exempt) | `relationship` | 13 — `assistant_thread` ×9, `assistant_memory` ×4 | base role `user` + `owns` (+ `inTenant`, `notLow`); fails closed on missing `ownerId` | boundary pin §5.3 + live owner/deny suite |
| ungrantable (bypass-exempt) | `channel` | 1 — `mcp_tool:call` | base role `hub_caller`, mintable only by the hub's OBO path; platform principals always carry `roles: ["user"]` (`src/rbac/cerbos.ts:34`), so no platform request can ever match | boundary pin + the principalPayload invariant (worth a one-line test in IAM-04c-2's scope) |
| ungrantable (bypass-exempt) | `code-gate` | 1 — `agent_run:read` | elevated access granted by `isElevated()` in code BEFORE Cerbos; the Cerbos rule is a purely additive owner path (`owns` + `origin=="assistant_handoff"` + `notLow`) | boundary pin + `cerbos-agent-run.test.ts` + the controller-order contract in the policy header |

Notes carried into the revision:

- **"Bypass-exempt" is an invariant of the whole ungrantable class, not a third class** — the
  current table's third row ("same 15") already hinted at this; make it explicit.
- `agent_run:read` is honestly *dual-mechanism* (its Cerbos-visible grant is ownership; the
  reason it is outside the superadmin matrix is the code gate). Classify by **why it is exempt
  from the role/bypass axis** — `code-gate` — and say the owner path in the mechanism notes,
  which the table above does.
- **Do NOT rename the stored enum during Phase 1.** `class: "relationship"` is CHECK-constrained
  in 0093, trigger-referenced, seeded by 0094, asserted by the parity suite, and the catalog JSON
  is the declared inter-agent contract for the concurrent wave. The JSON's `_meta.classes`
  description already carries the honest caveat ("or via the hub channel"). The cheap, safe
  change now: add an additive `mechanism` field to the 15 JSON entries + revise the two docs'
  tables (this table). If the owner wants the enum itself renamed (`relationship` →
  `ungrantable`), do it as one deliberate change at the IAM-07a freeze — renames are cheap
  *before* the freeze but not *during* a four-agent concurrent wave on the same files.

---

## 7. Follow-up tickets (PLANNED — none started; specify-only per this ticket's constraints)

Tier legend per the phase doc. Model·effort: seat default unless flagged — none of these needs
Opus; each is precisely specified above.

| ID | Tier | Model·effort | Depends | Ticket + acceptance criteria |
|---|---|---|---|---|
| **IAM-04c-1** | S (qa) | seat default | none (do first) | **The 215-boundary pin test** per §5.3, in `src/rbac/` beside the parity suite, with its own UNFILTERED derivation + the checked-in exempt-kind registry. Also fix G1: correct `role-permission-parity.db.test.ts`'s header claim and the vacuous `cerbosLeak` arm. **Done when:** green on today's tree; proven red under all three §5.3(3) mutations (show the runs); parity suite still 22/22; registry constant documented as owner-sighted. |
| **IAM-04c-2** | M | seat default | soft: 04c-1 | **Live-PDP hardening:** add global-scope `platform_admin` DENY cases to `cerbos-assistant.test.ts` for all 9 thread + 4 memory actions; add `handoff`/`confirm_write` to its matrix; add a one-line invariant test that `principalPayload` never emits any role besides `user` (the channel-mechanism guard). **Done when:** suite green against a freshly-restarted `gaiada-test-cerbos` (restart discipline in the test-run steps); a temporary thread-policy wildcard makes the new cases red at the PDP. |
| **IAM-04c-3** | M | seat default | coordinate with the IAM-01b file owner | **Mechanism annotation:** add additive `mechanism` ("relationship"/"channel"/"code-gate") to the 15 entries in `permission-catalog.json` + revise the three-class tables in `2026-08-10-permission-catalog.md` §5 and `2026-08-10-iam-01a-02a-analysis.md` Ruling 3 to §6's binary-class + mechanism form. **NO change** to the DB `class` enum, 0093, 0094, or any policy. **Done when:** catalog JSON still parses with 230/215/15 counts unchanged; parity + catalog DB tests green; both docs show the revised table. |
| **IAM-04c-4** | J | seat default | folds into IAM-07a | **Contract-doc clause:** the §4.3 authoring rule (every new resource policy decides the bypass explicitly: tier `*` rule, or registry entry + header rationale) + the §2.4 permanent disposition (tier rules never migrate to permission matching; exempt kinds never gain permission-matching rules). **Done when:** IAM-07a's published contract carries both clauses verbatim-equivalent, citing this ruling. |
| **IAM-14 spec amendment** | S (architect — absorbed by this ruling) | — | Phase 3 | §3 is binding input to IAM-14: owner = permission-native generated-by-exclusion bundle; exemption stated structurally (§3.2 wording); envelope exclusion list = owner decision; release-process-only mutability recommendation; **new hard dependency: IAM-04 permission matching must cover owner's envelope kinds before IAM-14 activates** (§3.4 — the program doc's Phase 3 section needs this edit). |

Directive for the **concurrent IAM-04a/04b agents** (relay, do not wait): the hold on `*` rules
is now the permanent ruling — leave all 56 untouched in every phase; add no permission-matching
rules to the four exempt kinds; permission-derived roles/conditions they introduce must not be
satisfiable by any relationship-class key (none exist in the catalog, so this is automatic —
just don't invent keys for the 15).

## 8. Open questions that need the OWNER (not architecture)

1. **IAM-14 envelope exclusion list membership** — which grantable permissions are
   "platform/system controls" denied to `owner` (§3.3 has seed candidates + tensions, notably
   `core.rollup.read` for a holding-level owner and `core.user.*`). The mechanism is ruled here;
   the list is the owner's.
2. **Owner-bundle mutability** (§3.3): accept the release-process-only recommendation, or allow
   runtime editing via superadmin's global-library UI? Recommendation stands: release-only.
3. **Bless the exempt-kind registry** (§5.3(1)) as the canonical, owner-sighted exemption list —
   a test constant becoming contract. (Editing it should thereafter appear in the IAM-07a
   contract's change-control note.)
4. **Optional, low priority:** rename the stored class enum `relationship` → `ungrantable` at
   the IAM-07a freeze (§6). Default if unanswered: keep the stored name, keep the additive
   `mechanism` field, revise docs only.
5. **Carried, not new:** holding-level owner auto-implication (program §6) — decide alongside
   (1), since it determines whether the holding owner's grant list is per-company rows or one
   holding-scope grant.
