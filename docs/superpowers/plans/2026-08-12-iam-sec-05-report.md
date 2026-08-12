# IAM-SEC-05 — REPORT: `inviteUser` privilege-escalation, closed at the write path

**Status: DEV-VERIFIED** (fix + new tests driven against the real test Postgres + test Cerbos,
teeth proven by disabling each guard and observing the failure, then restoring it — see §4).
Gate suite for the touched areas is green except one **pre-existing, unrelated** failure (§6).

## 1. The defect (as found by IAM-04c's ruling)

`inviteUser` (`POST /:tenantId/users`) minted its optional initial `user_roles` grant with a
**hardcoded `'company'` scope** and only a role-**existence** check — never
`ROLE_SCOPE_CONSTRAINTS`, the map `assignRole` already consulted. A caller holding `user:create`
(`company_admin` and above) could invite any target with `roleId` = `platform_admin`'s /
`group_executive`'s / `org_unit_lead`'s id and mint `platform_admin@company:X` /
`org_unit_lead@company:X` — the exact IAM-SEC-02/04 self/other-escalation shape the constraint map
exists to make structurally impossible, reachable through the one writer it was never wired onto.
The controller's own comment calling `assignRole` "the only unrestricted grant write path" was
false; that comment is fixed as part of this change.

## 2. The fix — one shared helper, two callers

`platform-nest/src/admin/admin-identity.controller.ts`:

- **New helper** `assertRoleScopeAllowed(roleName: string, scopeType: string): void` (just above
  `AdminIdentityController`, next to `ROLE_SCOPE_CONSTRAINTS`). Throws `BadRequestException` when
  the scope isn't in the role's allowed set; otherwise a no-op. This is now the **only** place the
  scope-constraint check is written.
- **`assignRole`** (`POST :tenantId/users/:userId/roles`): its inline check is replaced with
  `assertRoleScopeAllowed(role.rows[0].name, scopeType)`. Behaviour unchanged (same message, same
  400).
- **`inviteUser`** (`POST :tenantId/users`): the existence-only check
  (`SELECT 1 FROM roles WHERE id = $1`) is replaced with a name-fetching query, and
  `assertRoleScopeAllowed(role.rows[0].name, "company")` is called — **before any write**, i.e.
  before the user lookup/creation, before the membership upsert, before the adopt hook. This is
  the transactional-integrity decision the ticket asked me to make explicit: **a refused role
  leaves NO row behind at all** — not a half-onboarded user with a silently dropped role, and
  certainly not a `user_roles` row. If an admin needs to both invite someone AND grant them a
  scope-constrained role (`platform_admin@global`, `org_unit_lead@org_unit`, `group_executive@global`),
  the flow is: invite without `roleId`, then call `assignRole` — the only endpoint that can express
  a non-company scope at all. That limitation is stated in the code comment at the call site.

Both call sites are at `admin-identity.controller.ts:237` (`inviteUser`) and `:361` (`assignRole`).

## 3. Full `user_roles` writer enumeration

Swept `platform-nest/src` and `platform-nest/migrations` for every `INSERT INTO user_roles` /
`UPDATE user_roles` / `DELETE FROM user_roles`, plus `mcp-hub/` and `automation/` (no hits — no
role-assignment surface exists there).

| Writer | File:line | Can the caller choose role+scope? | Status |
|---|---|---|---|
| `inviteUser`'s optional grant | `admin-identity.controller.ts:~253` | roleId caller-chosen, scope hardcoded `'company'` | **GUARDED** — now calls `assertRoleScopeAllowed` before any write (this ticket) |
| `assignRole` | `admin-identity.controller.ts:~375` | roleId AND scopeType/scopeId all caller-chosen | **GUARDED** — pre-existing, unchanged behaviour, now via the shared helper |
| `revokeRole` (DELETE) | `admin-identity.controller.ts:~419` | deletes by grant id only | N/A — not a grant-minting writer |
| service-reconciler materialization | `service-reconciler.ts:279` | role_id resolves ONLY to `<module>_staff`/`<module>_manager` via `moduleRoleId()`, derived from the service assignment's own module contract, never request input; scope hardcoded `'company'`/served tenant | **TRUSTED** — no caller-chosen role or scope reaches this INSERT |
| service-reconciler revoke (DELETE) | `service-reconciler.ts:364` | deletes reconciler-managed rows by id | N/A — not a mint |
| `adoptManagedGrantAsManual` (UPDATE) | `service-reconciler.ts:450` | clears `managed_by` on an existing row by id; never touches role_id/scope | N/A — not a mint |
| portal-accept grant | `client-contacts.controller.ts:365` | role looked up by the **literal name** `'client'`, scope hardcoded `'company'` | **TRUSTED** — a client contact accepting their own invite cannot choose a different role/scope |
| portal-clients seed | `seed/portal-clients.ts:205` | identical hardcoded `'client'`-by-name + `'company'`-scope shape | **TRUSTED** — seed script (owner/migrator context, not a request handler), same shape as above |
| `grantRole()` test helper | `testing/fixtures.ts:104` | role/scope are TEST-code arguments | **TRUSTED** — test-only, never imported by production code; `testing/personas.ts` calls through this helper rather than writing SQL directly, so it produces no separate hit |
| migration 0073 dedupe | `migrations/0073_dedupe_global_roles.sql` | collapses duplicate rows, never re-pairs role↔scope | N/A |
| migration 0092 dedupe | `migrations/0092_user_roles_global_scope_unique.sql` | same — collapse only | N/A |

No hit in `mcp-hub/` or `automation/` for `user_roles`/`assignRole`/`scope_type` — no
role-assignment surface exists on those services.

**Net: two production writers can mint a grant from a caller-chosen role at all. Both are now
guarded through the single shared helper.** Every other writer is either a delete/update that
never sets `(role_id, scope_type, scope_id)`, or hardcodes a correct pair with no caller influence,
each stated above with the reason.

## 4. The durable half — `user-roles-writer-guard.test.ts` (new file)

`platform-nest/src/admin/user-roles-writer-guard.test.ts` — static-only sweep, same discipline as
`managed-by-invariant.test.ts`'s Part 6 (fresh re-parse every run, never a hand-frozen snapshot):

- `findRoleGrantWriters()` walks `src/`, regex-matches `INSERT INTO user_roles(...)` whose column
  list contains `role_id`, and returns the files that hit.
- Every hit must be either in `TRUSTED_WRITERS` (with an inline, code-verified reason — the same
  five reasons in §3's table) or in `GUARDED_WRITERS` (must additionally reference
  `assertRoleScopeAllowed(` in the file).
- A **per-method** teeth-proof extracts `inviteUser`'s and `assignRole`'s own bodies from
  `admin-identity.controller.ts` (stripping `//` comments first — see the teeth-proof note below)
  and asserts each one, independently, calls the helper — so a future refactor that keeps the call
  in one method but drops it from the other is caught by name, not laundered through a file-level OR.
- A "no stale entries" check the other direction: every file named in `TRUSTED_WRITERS`/
  `GUARDED_WRITERS` must still actually be found by the sweep, so a moved/deleted writer can't hide
  behind a stale allowlist entry.

**This is the IAM-SEC-07 writer-coverage deliverable**: add a fourth writer tomorrow with a raw
caller-controlled `roleId` and no scope check, and `findRoleGrantWriters()` will find it, it will
be in neither list, and the test goes red without anyone needing to remember this ticket.

## 5. Machine-checked `ROLE_SCOPE_CONSTRAINTS` completeness (both directions)

`permission-arm-hazard-scan.test.ts` already machine-checked the **global-only** direction at
`:707` (every Pattern-C role whose condition is global-only must appear in the map, via
`loadGlobalOnlyRolesFromController()`). Nothing mirrored that for the **other-narrow** direction
(`client`, `org_unit_lead`) — that half of the map was maintained by hand.

Added, right after the existing `:722` reachability test (which is **untouched**, per the
ticket's explicit instruction not to loosen it):

- `loadOtherNarrowRolesFromController()` — same derivation as `loadGlobalOnlyRolesFromController`,
  just the complementary half of the same map, so the two views cannot drift apart.
- A new test, "REACHABILITY (other-narrow direction) completeness…", mirroring `:707`'s structure:
  every role the policy sweep finds in the other-narrow Pattern-C shape must be present in
  `ROLE_SCOPE_CONSTRAINTS`, **plus** a direct pin: `expect(otherNarrowRoles.has("client"))` and
  `expect(otherNarrowRoles.has("org_unit_lead"))` must both be `true`. Removing either role from
  the map turns this test red (proven in §6).

`appraisal`/`report_document` remain unwired (`:722` untouched, no `perm_*` arm added to either
kind) — that ruling stays **OPEN**, as instructed; this ticket only closes the write path.

## 6. Teeth proofs — each guard disabled, observed RED, then restored

All done via `Edit` on the real source, re-running the real suite against the real test Postgres
(`gaiada-test-pg`, port 55433) and test Cerbos (`gaiada-test-cerbos`), then reverting.

**(a) `assertRoleScopeAllowed`'s body neutered** (made a no-op) →
`npx vitest run src/admin/global-only-role-scope.test.ts`:

```
Test Files  1 failed (1)
     Tests  8 failed | 6 passed (14)
```

The 8 failures were exactly the 8 refusal-expecting tests (4 pre-existing `assignRole` refusals +
4 new `inviteUser` refusal/no-partial-state tests), e.g.:

```
FAIL … refuses to invite-with platform_admin … with a clean 400
AssertionError: expected 201 to be 400
  - 400
  + 201
```

The 6 happy-path tests stayed green, confirming the failures are specifically about the missing
refusal, not collateral damage. Restored; re-ran green (§7).

**(b) `inviteUser`'s own call to the guard commented out** (guard body intact; only the
`assignRole` call site still calls it) → first pass at
`npx vitest run src/admin/user-roles-writer-guard.test.ts` **wrongly stayed green** — the
naive `.toContain("assertRoleScopeAllowed(")` matched the commented-out line's own text. Caught
and fixed: added `stripLineComments()` before the containment check in both per-method tests. Re-ran
with the same disabled call:

```
Test Files  1 failed (1)
     Tests  1 failed | 4 passed (5)

FAIL … inviteUser's own LIVE (non-comment) body calls assertRoleScopeAllowed
AssertionError: expected [inviteUser's body text] to contain 'assertRoleScopeAllowed('
```

Restored; re-ran green (§7). Documented as a real near-miss: a comment-tolerant string search is
not sufficient teeth on its own, which is exactly why this suite's teeth were proven adversarially
rather than assumed.

**(c) `client`/`org_unit_lead` commented out of `ROLE_SCOPE_CONSTRAINTS`** →
`npx vitest run src/rbac/permission-arm-hazard-scan.test.ts`:

```
Test Files  1 failed (1)
     Tests  1 failed | 124 passed (125)

FAIL … REACHABILITY (other-narrow direction) completeness: …
AssertionError: ROLE_SCOPE_CONSTRAINTS must be parseable from the controller source: expected 0 to be greater than 0
```

Restored; re-ran green (125/125, §7).

## 7. Happy-path proof (the guard must not over-refuse)

From `global-only-role-scope.test.ts`'s new IAM-SEC-05 block, all passing with the guard live:

- Inviting with `client` (company scope, `client`'s own legitimate scope) → `201`, and the DB row
  is verified directly: `user_roles.scope_type = 'company'`, `scope_id = <tenant>`.
- Inviting with `manager` (a non-constrained role) at company scope → `201`.
- Inviting with **no** `roleId` at all (the plain onboarding flow) → `201`.
- Refusing `platform_admin`/`org_unit_lead` → clean `400`, message names the correct required
  scope (`"global scope"` / `"org_unit scope"`), and — the no-partial-state proof — the `users`
  table has **zero** rows for that invite's email afterward.

## 8. Gate results (targeted only, per the ticket's instruction not to run full `npm test`)

Ran against `gaiada-test-pg` (55433) + `gaiada-test-cerbos` (3592/3593), both already up.

- `npm run typecheck` → **0 errors**.
- `npx vitest run src/admin/user-roles-writer-guard.test.ts` → **5/5 passed**.
- `npx vitest run src/rbac/permission-arm-hazard-scan.test.ts` → **125/125 passed** (includes the
  new other-narrow completeness test).
- `npx vitest run src/admin/global-only-role-scope.test.ts` → **14/14 passed** (8 pre-existing +
  6 new IAM-SEC-05 tests).
- `npx vitest run src/rbac/ src/admin/` (full targeted sweep, includes
  `role-permission-parity.db.test.ts` [27/27] and `iam-215-boundary-pin.test.ts` [73/73]) →
  **744/745 passed**. The **one** failure,
  `org14-preflight-adversarial.test.ts › T6 client-supplied module/origin cannot forge elevated
  visibility` (`expected 200 to be 403`), is **pre-existing and unrelated**: verified by
  `git stash`-ing every change in this ticket and re-running that single file against unmodified
  `main` — it fails identically (same assertion, same line). It concerns an HR-approval
  decide-forgery path, not `user_roles` or role scoping, and none of this ticket's files are
  imported by it. Flagging as a pre-existing gap for another ticket, not claiming it as fixed or
  caused by this change.

## 9. Files touched

- `platform-nest/src/admin/admin-identity.controller.ts` — the fix (shared helper, both call
  sites, corrected comment).
- `platform-nest/src/admin/global-only-role-scope.test.ts` — new IAM-SEC-05 `describe` block
  (inviteUser refusal / no-partial-state / happy-path tests).
- `platform-nest/src/rbac/permission-arm-hazard-scan.test.ts` — new
  `loadOtherNarrowRolesFromController()` + completeness test near `:722` (`:722` itself untouched).
- `platform-nest/src/admin/user-roles-writer-guard.test.ts` — new file, the writer-coverage
  invariant (IAM-SEC-07 half).
- `docs/superpowers/plans/2026-08-12-iam-sec-05-report.md` — this report.

No migrations, Cerbos policies, `principal.ts`, `cerbos.ts`, or `platform-ui/` were touched, per
the ticket's constraints. Tree left dirty; not committed, not pushed.

## 10. Blockers / follow-ups

- None blocking this ticket's scope. The IAM-04c ruling's broader question (closure path for
  `appraisal`/`report_document` — option A/B/C) remains **OPEN** and is explicitly out of scope
  here; I did not touch `:722`, `principal.ts`, or any Cerbos policy.
- `org14-preflight-adversarial.test.ts` T6 is a **pre-existing, unrelated** red — worth a ticket of
  its own; not addressed here since it is outside this ticket's owned files and outside the
  privilege-escalation defect class this ticket closes.
