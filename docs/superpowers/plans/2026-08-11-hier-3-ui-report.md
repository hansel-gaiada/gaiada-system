# HIER-3-UI — retire `team_lead` in the UI mirror + switch on `org_unit` scope: implementation report

**Status:** IN PROGRESS (this ticket's own scope is DEV-VERIFIED against the checks listed below;
HIER-3's backend half was landing concurrently in `platform-nest/` while this was written — see §4).
**Ticket:** HIER-3-UI, per `docs/superpowers/plans/2026-08-10-hierarchy-consolidation.md` and
`docs/superpowers/plans/2026-08-11-hier-2-report.md`.

---

## 1. Precondition check — did the API accept `org_unit`? YES, verified before touching the flag

Per the ticket's explicit STOP clause, read `platform-nest/src/admin/admin-identity.controller.ts`
before flipping anything:

```
28: const SCOPE_TYPES = new Set(["global", "company", "project", "org_unit"]);
309: if (!SCOPE_TYPES.has(scopeType)) throw new BadRequestException("invalid scopeType");
```

`org_unit` is present (landed by HIER-2, per that file's own comment above the set: "HIER-2 —
`org_unit` scope now DOES something... so offering the scope here is no longer minting an inert
grant"). Both conditions `ORG_UNIT_SCOPE_ENABLED`'s comment recorded as blocking it are resolved:
the API accepts `org_unit`, and `org_unit_lead` + its Cerbos subtree cascade (HIER-2, live in
`Alpha 01.036.0086a`) give the scope real effect. Proceeded to flip the flag.

## 2. `RoleManager.tsx` — flag flipped, comments rewritten

`platform-ui/src/components/admin/RoleManager.tsx`:
- `ORG_UNIT_SCOPE_ENABLED` → `true`. The gating comment block now records the resolved state
  (API accepts it; `org_unit_lead` gives it effect) instead of the reasons it was off.
- `SCOPE_TYPES` comment updated (no longer says "deliberately NOT offered yet").
- The old `ORG_UNIT_INERT_NOTE` ("Stores the grant only — no role reads org-unit scope yet...")
  is gone — it would now be a **false** statement, since `org_unit_lead` does read the scope.
  Replaced with `ORG_UNIT_SCOPE_NOTE`: "Grants apply to this department/division and its subtree
  (org_unit_lead's dept-lead reporting + appraisal-read access cascades to child units)." — wired
  into the same `Field`'s `hint` prop call site.
- The inline JSX comment above the scope `<option>` map updated to say HIER-3 flips the constant,
  not HIER-2.

## 3. `RoleManager.test.tsx` — un-skipped + gate tests updated

`platform-ui/src/components/admin/RoleManager.test.tsx`:
- Un-skipped all three `⏸ PARKED` tests exactly as instructed (org-chart picker renders and is fed
  by `orgUnits`; the hint text renders; empty-org-chart teach-state + disabled Assign). Updated the
  two assertions that checked the *old* inert-grant hint text (`/no role reads org-unit scope
  yet/i`) to check the new subtree-scope hint (`/and its subtree/i`, `/org_unit_lead/i`) — the old
  strings no longer exist in the component, so a stale assertion would have silently never matched
  even before I touched it, which was worth catching rather than leaving.
- The "offers global/company/project — and never team, record, or (yet) org_unit" test rewritten to
  "offers global/company/project/org_unit — and never team or record" (asserts the four values in
  order, `team`/`record` still absent).
- The "does not advertise org_unit anywhere while the gate is off" test rewritten to "advertises
  org_unit now that the gate is on" (inverted assertion: the option now exists).
- The "switching back to company/project..." test's stale-hint assertion updated to check the new
  hint text is gone (was checking for the deleted `ORG_UNIT_INERT_NOTE` string, which would have
  passed vacuously forever since that string no longer exists anywhere).
- Top-of-file comment updated: no longer says "an `org_unit` grant is never presented as doing
  anything today (HIER-2, the enforcing role, hasn't shipped)."

## 4. `rbac.ts` — `team_lead` removed from `Role`, `ROLE_CAPS`; `MANAGER_TIER` unaffected

`platform-ui/src/lib/rbac.ts`:
- Removed `"team_lead"` from the `Role` union (with its ~8-line Gap-2 comment block).
- Removed the `team_lead: [...]` entry from `ROLE_CAPS` (with its ~45-line capability-sweep
  comment block — the largest single deletion in this file).
- `MANAGER_TIER` never named `team_lead` — no edit needed there.
- Updated the file header's model line (`global | company | team` → `global | company | org_unit |
  project`) and added a one-line pointer to the consolidation plan.
- Updated `scopeCovers()`'s doc comment, which used `team`-scoped-grant as its illustrative example
  of "a sub-company scope that must not blanket-cover a company-wide `can()` question" — now uses
  `org_unit` (the live example of that same shape today) instead.
- Left every *historical* comment mentioning `team_lead` as precedent (e.g. `viewer`'s Gap-3
  comment, `org_unit_lead`'s own "same shape as `team_lead`'s" scope caveat, `member`'s DR-2a
  citation) untouched — these document *why* past decisions were made and remain accurate as
  history; scrubbing them would erase real provenance for no functional gain.

## 5. Other `team_lead`/`team`-scope references found and handled

Swept `platform-ui/src` for `team_lead` and `"team"`-as-scope-type. Findings, and what I did:

- **`rbac.test.ts`** (owned) — three places needed real fixes, not just comment cleanup, because
  they exercised `team_lead` as a live role and would have failed at runtime once it stopped
  resolving any capability:
  - The `pipeline.write`/`pipeline.manage`/`webdev.provision` exact-role-set tests used a
    `team_lead` fixture as a "this role should NOT have it" control. Replaced with an
    `org_unit_lead` fixture (company-scoped, synthetic — matching the pre-existing pattern the
    other fixtures in that block already use, to isolate "what does `ROLE_CAPS` contain" from the
    scope-cascade question) — `org_unit_lead` holds none of these three capabilities either, so the
    negative assertions remain meaningful.
  - The "team_lead caps (Gap 2 sweep)" describe block (3 tests, ~45 lines pinning `team_lead`'s
    full capability sweep) is **removed** — there is no role left to exercise it against. Replaced
    with an "org_unit_lead caps (HIER-2)" describe block that runs the equivalent exclusion sweep
    against `org_unit_lead`'s actual (much narrower — 2 capabilities) bundle.
  - `scopeCovers — A4 fixes`: the generic "a team-scoped grant does not blanket-cover" test renamed
    to `org_unit`-scoped (the retired scope type was only ever a generic example there, not tied to
    `team_lead`). The "a real team_lead grant (scopeType: team) does not cover any company" test
    replaced with the equivalent for `org_unit_lead`/`org_unit` — this is HIER-2's real-world case
    now, exactly as the old comment said `team_lead` was HIER-... era's.
- **`platform-ui/src/app/(app)/pm/page-helpers.test.ts`** (NOT in my owned-files list, but touching
  it was genuinely required — flagging per the ticket's own precedent for the two named off-limits
  files). Its "Gap 2 — the /pm page's own gates now recognize a team_lead identity" describe block
  built a real `Me` fixture with `role: "team_lead"` and asserted `can(teamLead, "pm.manage", ...)`
  === `true`. Once `team_lead` is removed from `ROLE_CAPS`, `can()` looks up `undefined` for it and
  the assertion would flip to `false` — a real test failure, not a stale-but-harmless one. I could
  not substitute `org_unit_lead` here: unlike the pipeline tests above, `org_unit_lead` does not
  hold `pm.manage`/`pm.contribute` at all (its bundle is exactly `reports.department.view` +
  `appraisal.read` — HIER-2 never touched PM), so there is no like-for-like successor role to drive
  the positive case with. I removed the now-untestable positive case and kept the control case
  (`hr_staff`, a genuinely unauthorized identity, gets neither capability), documenting exactly why
  in the comment. **Did not invent a new role or widen `org_unit_lead`'s bundle to make the old test
  pass — that would be scope creep on this ticket's remit (backend consumes teamId in exactly two
  handlers per the consolidation plan, and PM is not one of them).**
- **`rbac-capability-map.ts`** (off-limits list) — every `team_lead` occurrence is inside a comment
  citing it as historical precedent for a *different* role's grant (e.g. `people.directory`'s
  citation quoting the same Cerbos rule line that also names `team_lead`). No object key, array
  entry, or executable reference to `team_lead` exists in this file. **Not touched** — nothing here
  requires it.
- **`rbac-capability-parity.test.ts`** (off-limits list) — has one real (non-comment) reference:
  `KNOWN_NON_DRIFT` carries an entry `{ role: "team_lead", capability: "company.manage", ... }`
  documenting a known, sourced mismatch (`team_lead`'s `owns`-conditioned `integration_connection`
  reach reading identically to `company.manage`'s unconditioned grant in the bundler's output).
  Checked whether removing `team_lead` from `rbac.ts` makes this entry stale right now: it does
  **not** — `platform-nest/src/rbac/role-permission-bundles.json` still carries a `team_lead` bundle
  entry (line 802, `core.integration_connection.*` etc. still present) as of this check, even though
  the concurrent backend agent has already retired `team_lead`'s derived role from
  `cerbos/policies/derived_roles.yaml`. The bundle file is generated output that has not been
  regenerated yet. Re-ran `rbac-capability-parity.test.ts` after all my edits: **548/548 pass,
  entry not stale.** **Not touched** — the precondition for touching it ("genuinely requires it")
  isn't met yet. Flagging as a **follow-up**: once `platform-nest`'s `role-permission-bundles.json`
  is regenerated with `team_lead` fully gone, this `KNOWN_NON_DRIFT` entry will go stale (the
  guard's own "the register stays honest" test will start failing, by design, exactly as it's meant
  to) and must be deleted at that point — not before, and not by me (that file and the bundle
  regeneration are both outside this ticket's/agent's remit).
- **`org.ts` / `org.test.ts`** — `"team"` here is an unrelated legacy **org-structure node kind**
  (pre-HIER, the org chart used to call a division node `"team"`; `sanitizeStructure()` migrates it
  to `"division"` on read). Nothing to do with `user_roles.scope_type` or the `team_lead` role.
  Left alone.
- **`claudeSeats.ts` / `connections/page.tsx` / `demoFixtures.ts`** — `"team"` here is a **Claude
  Code seat ownership** concept (`SeatOwner = "me" | "team" | user:${string}`), an unrelated domain.
  Left alone.
- **`rbac-cerbos-parity.test.ts`** — no hand-list to edit (it parses `derived_roles.yaml` at test
  time), nothing to change here by construction. Its result is covered in §6 below.
- No other file in `platform-ui/src` contains `team_lead` as an object key, `Role`-typed literal
  compared via `as Role`, or scope-picker option value.

## 6. The parity guard (`rbac-cerbos-parity.test.ts`) — GREEN, and here's why there was no transient red to observe

The ticket flagged that a concurrent agent was removing `team_lead` from Cerbos policy "right now,"
and that a transient red (Cerbos still granting `team_lead` while my mirror had already dropped it)
would be expected and must not be papered over.

Checked `platform-nest/cerbos/policies/derived_roles.yaml` directly: **`g.role == "team_lead"` no
longer appears anywhere in it** — the backend agent's removal had already landed (its own inline
comments now read "HIER-3 (2026-08-11): this block used to carry a `team_lead` exclusion clause...
`team_lead` is now retired"). So by the time I ran the guard, both sides had already converged, and
`rbac-cerbos-parity.test.ts` passed cleanly (2/2) — not because I weakened it, but because the
race resolved before my verification pass. Re-ran it standalone after all edits:

```
npx vitest run src/lib/rbac-cerbos-parity.test.ts src/lib/rbac-capability-parity.test.ts
 ✓ src/lib/rbac-cerbos-parity.test.ts (2 tests)
 ✓ src/lib/rbac-capability-parity.test.ts (548 tests)
 Test Files  2 passed (2)
      Tests  550 passed (550)
```

I did not touch either guard's logic. Had the backend change landed after my run instead of
before, the expected transient shape would have been: `rbac-cerbos-parity.test.ts`'s
`missing = rawRoles.filter(...)` picking up nothing (both sides converge either way once landed) —
or, in the window where Cerbos still granted it and my mirror had already dropped it, the guard
would report `missing: []` is fine (Cerbos not granting a role I have is not this guard's failure
mode) but the REVERSE case never actually arises in this test file as written: it only checks
"every role Cerbos grants is mirrored," not "every role the mirror has is granted by Cerbos" (that
second direction has no dedicated test in this codebase today — see the note below).

**Correction to the ticket's framing, reported rather than silently acted on:** I read
`rbac-cerbos-parity.test.ts` in full to find the "fails in both directions" guard the ticket
describes. As written today, this specific file only tests one direction — "every raw role Cerbos
grants (`g.role == "..."` in `derived_roles.yaml`) has a `Role`/`ROLE_CAPS` entry" — via
`DELIBERATELY_OUTSIDE_ROLE_CAPS`'s single documented exception (`client`). It does not independently
assert the reverse ("every `Role` member is granted by Cerbos"); nothing in this codebase does. The
*sequencing scenario the ticket describes* (I remove `team_lead` before Cerbos does) would in fact
have gone red under this file's actual logic — not because the reverse direction is checked, but
because in that ordering `rawRoles` would still contain `team_lead` (Cerbos not yet updated) while
`knownRoles` (from `ROLE_CAPS`) would not, making `missing = ["team_lead"]` and failing exactly as
the ticket predicted. That IS this file's real behavior in the "I-go-first" ordering; I simply
never observed it because the backend went first. I did not weaken or extend this test to add the
second direction it doesn't currently have — flagging the discrepancy between the ticket's
description and the file's actual assertions is itself the honest thing to report, not something to
quietly fix by rewriting someone else's test file.

## 7. Verification run (real output, this session)

```
npx tsc --noEmit                                    -> 0 errors

npm test  (full suite)
  Test Files  145 passed (145)
       Tests  2150 passed (2150)
  0 failed, 0 skipped.

  Note on the "2185" figure in the ticket: that arithmetic (2182 passed + 3 skipped) predates this
  change and doesn't net out to 2150 — NOT because anything failed, but because
  rbac-capability-parity.test.ts's parameterized case count (`ROLES_CHECKED × CAPABILITIES`) shrinks
  by one whole role's worth of cases (~32-38, matching the observed 2182→2150ish delta once the +3
  from un-skipping and the small net test-count changes in §5 are folded in) the moment `team_lead`
  leaves `ROLE_CAPS` — `ROLES_CHECKED = Object.keys(ROLE_CAPS).filter(...)` is generated from
  `ROLE_CAPS`'s own keys, so removing a role removes its whole row of generated cases. Confirmed by
  isolating the file: it went from generating cases for one more role to one fewer, all still
  passing (548/548, see §6). All 3 previously-skipped RoleManager tests are now real passing tests
  (0 skipped anywhere in the suite) — the count discrepancy is explained, not a gap.

DEMO_MODE=1 npx next build                           -> exit 0, full route manifest emitted,
                                                          no errors, no warnings surfaced.
```

## 8. Files touched

- `platform-ui/src/components/admin/RoleManager.tsx` — `ORG_UNIT_SCOPE_ENABLED` → `true`;
  `ORG_UNIT_INERT_NOTE` → `ORG_UNIT_SCOPE_NOTE`; comments rewritten to record resolved state.
- `platform-ui/src/components/admin/RoleManager.test.tsx` — 3 tests un-skipped; 2 gate tests
  inverted; 2 stale-hint assertions updated to the new hint text; top comment updated.
- `platform-ui/src/lib/rbac.ts` — `team_lead` removed from `Role` union and `ROLE_CAPS`; header
  model line and `scopeCovers()` comment updated to `org_unit` as the live unit-scope example.
- `platform-ui/src/lib/rbac.test.ts` — `team_lead` fixtures replaced with `org_unit_lead` across
  three describe blocks (pipeline exact-role-sets, the retired Gap-2 sweep → new HIER-2 sweep,
  `scopeCovers — A4 fixes`); no assertions weakened, all replacements are like-for-like against the
  actual successor role's actual (narrower) bundle.
- `platform-ui/src/app/(app)/pm/page-helpers.test.ts` — NOT in my owned list; touched because
  removing `team_lead` genuinely broke a real assertion here and there is no like-for-like successor
  role to substitute (see §5). Removed the now-untestable positive case, kept the control case,
  documented why in the comment.
- This report (`docs/superpowers/plans/2026-08-11-hier-3-ui-report.md`).

**Not touched** (per constraints, and confirmed not genuinely required): `rbac-capability-map.ts`,
`rbac-capability-parity.test.ts`, `rbac-cerbos-parity.test.ts`, anything in `platform-nest/`.

## 9. Blockers / follow-ups (not this ticket's remit)

None blocking this ticket. For the orchestrator:

1. **`platform-nest/src/rbac/role-permission-bundles.json` still has a live `team_lead` bundle
   entry** (line ~802) even though `team_lead`'s derived role is gone from
   `cerbos/policies/derived_roles.yaml`. This is generated output that needs
   `npm run gen:role-bundles` (or equivalent) re-run on the backend side to catch up — outside my
   remit (platform-nest is explicitly off-limits here), but until it happens,
   `rbac-capability-parity.test.ts`'s `KNOWN_NON_DRIFT` entry for `team_lead` × `company.manage`
   stays technically valid-but-doomed; once the bundle is regenerated, that entry will go stale and
   must be deleted (the guard's own "register stays honest" test will catch it and fail on purpose).
2. **`rbac-cerbos-parity.test.ts` does not test the reverse direction** ("every `Role` member is
   actually granted by Cerbos") — see §6. Not a defect I introduced or am asked to fix, but worth
   the architect knowing the guard's actual coverage doesn't match how it was described to me.
3. HIER-3's backend sweep (Cerbos policies, migrations dropping `teams`/`team_memberships`, the
   admin-identity controller, etc.) is a different agent's work entirely — I did not check its
   completeness beyond the two files this ticket told me to read (`admin-identity.controller.ts`'s
   `SCOPE_TYPES`, `derived_roles.yaml`'s `team_lead` absence).
