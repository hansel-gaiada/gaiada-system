# IAM-VERIFY-02 — driving a low-assurance NAMED principal, and what that actually proves

**Status:** IN PROGRESS. This ticket's own instrument — `assemblePersonaPrincipal()`
(`platform-nest/src/testing/personas.ts`, additive) + one new test file
(`platform-nest/src/testing/iam-verify-02.low-assurance.test.ts`, 11 tests + 1 documented `it.todo`,
4 describe groups) — is written and GREEN in a live run on 2026-08-11 against `gaiada-test-cerbos`
(restarted at `2026-08-11T05:35:20Z`, confirmed `healthy` before the run) and a fresh per-file test
Postgres. `IAM-VERIFY-01`'s 29-test file was re-run immediately after this ticket's own edits and is
also still fully green (29/29) — the migration blocker that ticket reported (`0102`'s `RAISE
EXCEPTION` syntax defect) is no longer present on disk; `initTestDb()` now succeeds. Not re-litigated
here since it's not this ticket's finding to claim credit for or re-diagnose.

**Owns:** `platform-nest/src/testing/personas.ts` (additive only — `.as()` and its return shape are
byte-for-byte unchanged; only a new `.assemble()` method and a new exported
`assemblePersonaPrincipal()` helper were added), `platform-nest/src/testing/iam-verify-02.low-
assurance.test.ts` (new), this report. `principal.ts`, `guards.ts`, `config.ts`, every Cerbos policy,
and every migration are untouched — confirmed by `git status` before writing this report; the only
diffs under my ownership are those two files. `team_lead` was not used anywhere in the new test file
(the concurrent sweep's retirement of that persona is not a concern here).

---

## 1. The mechanism — why a NAMED principal cannot reach assurance `"low"` today (found by reading, then proven live)

Three principal-producing branches exist in `src/auth/guards.ts` + `src/auth/oidc.ts`; none of them
can put `"low"` and a non-null `userId` in the same `Principal`:

1. **Dev `x-user-id`** (`guards.ts` line 70, what `personas.ts`'s `.as()` uses) —
   `assemblePrincipal(userId, "high")`, unconditionally. No header varies it.
2. **OIDC bearer** (`oidc.ts`'s `assuranceFor()`) — returns only `"high"` (an `amr` MFA/OTP/hardware-
   key/TOTP claim) or `"linked"` (anything else verified by the IdP). `"low"` is not in its range.
3. **OBO envelope** (`guards.ts` lines 76–96, `x-obo-provider`/`x-obo-external-id`) — the one branch
   that looks capable: an `identity_links` row that **exists but is unverified** is exactly the real
   shape a not-yet-confirmed WhatsApp/Telegram identity has. But `AuthGuard`'s handling of that case
   is `req.principal = { ...ANONYMOUS }` — **`row.user_id` is discarded**, even though the row (and
   therefore the real user) is known. The result is indistinguishable from a totally unknown caller.

**The asymmetry that makes this a live, provable finding, not a reading of intent:** the identical
lookup exists a second time, in `src/identity/identity.controller.ts`'s `IdentityController.resolve()`
(the `/principal/resolve` endpoint mcp-hub calls). For the SAME "row exists, unverified" case, it
returns `{ ...ANONYMOUS, userId: row.user_id }` — **it keeps the user_id**. One of these two
implementations of "resolve an OBO envelope to a principal" is not like the other, and `AuthGuard` —
the one that gates every `/api` request `personas.ts` drives — is the one that erases it.

**Driven live** (Part 1 of the new test file), not inferred:

- `GET /api/:t/pm/tasks` with a real `member`'s **unverified** OBO envelope (`linkIdentity(userId,
  provider, externalId, verified=false)`, the exact production row shape) → **401/403**. `pm_task`'s
  role-arm read rule carries **no** `notLow` at all, so if `AuthGuard` preserved `userId` here the way
  `IdentityController.resolve()`'s sibling logic does, this exact request would be a 200. The denial is
  proof of **erasure**, not of the assurance floor working.
- `POST /principal/resolve` with the identical unverified row → **200**, body
  `{ userId: <the real user>, assurance: "low", companies: [] }`. Live confirmation of the asymmetry:
  same input, two different resolvers, two different outputs, only one of which platform-nest's own
  `/api` surface ever consults.

## 2. The deeper finding: even the ONE real "low + named" shape is powerless against `notLow` — by design, not oversight

`IdentityController.resolve()`'s unverified branch returns `companies: []` — it does **not** call
`assemblePrincipal()` for this case, so the real user's actual company/role grants never load. This
matches `principal.ts`'s own doc comment on the `Assurance` type verbatim:

> `'low'` — unverified link or unknown external identity: **no company data at all**.

That is not incidental. It means that in **every code path that exists in this codebase today**,
`assurance === "low"` implies `roles === []` and `companies === []`. Consequently:

- Every `notLow`-gated rule that ALSO requires `variables.inTenant` (the large majority — `agent_run`,
  every `hr_case`/`hr_record`/`pm_task`-adjacent kind, etc.) is **already denied by `inTenant` failing
  first**, before `notLow` is ever the deciding conjunct, for any principal a real guard branch can
  currently produce.
- The handful of `notLow`-only rules that don't also require `inTenant` (`resource_appraisal.yaml`,
  `resource_report_admin.yaml`'s `group_executive` carve-out, etc.) are gated on a `derivedRole` that
  itself requires a real `role_permissions`/`user_roles` grant — and a real "low" principal has `roles
  === []`, so those are denied on role grounds regardless of `notLow`.

**`notLow`, as currently reachable, is a forward-looking safety net rather than a load-bearing check
today** — nothing in production can currently construct a principal that is BOTH `assurance:"low"` AND
carries real tenant/role access simultaneously, so no live request today is denied BECAUSE of
`notLow` rather than because it already had zero access. This reframes the ticket's premise (`notLow`
gates 58 kinds "with zero e2e coverage") one level deeper: the reason coverage is zero is not only that
nobody wrote the fixture — it's that the shape the rule polices cannot currently occur. `notLow` earns
its keep the day a guard is added (or `identity.controller.ts`'s asymmetry with `guards.ts` is
resolved in the direction that preserves real company data for a linked-but-unverified user, or a
step-up-expiry mechanism downgrades an existing session's assurance) that CAN produce it. Until then it
protects against a principal shape this program has designed itself, structurally, never to emit.

## 3. What was built, and the honesty caveat that goes with it

`personas.ts` gained one additive method, `PersonaTenant.assemble(persona, assurance)`, and one
additive export, `assemblePersonaPrincipal(tenant, persona, assurance)` — both call the real,
unmodified `assemblePrincipal()` (the exact function every guard branch calls) for an already-seeded,
membership-bearing persona, with the `assurance` argument forced to whatever the caller asks —
including `"low"`. This is **not a fictional shape invented for testing**: `assemblePrincipal()`'s
`roles`/`perms`/`companies` queries depend only on `userId`, never on the `assurance` argument, so
calling it with `"low"` for a real company_admin returns that company_admin's real grants, just
labeled at a lower assurance than any current guard would apply to them.

**The caveat, stated as plainly as §2 above:** this is **not** the shape §1/§2 show production can
reach today. `assemblePersonaPrincipal(..., "low")` produces a principal with real `companies` —
exactly the thing `principal.ts`'s own doc comment says `"low"` should never have. A green result from
Part 2 of the new test file proves **the Cerbos-side `notLow` mechanics are correct for the day a guard
exists that can legitimately produce this shape** (a step-up-expiry downgrade of an existing session
is the most plausible future candidate) — it is deliberately **not** offered as proof that today's
running system is exposed to or defended against this case in live traffic, because live traffic
cannot construct it. Anyone reading a PASS on Part 2 without this paragraph would draw the wrong
conclusion about what is actually reachable right now; that is why this paragraph, and the equivalent
block comment in `personas.ts`, both exist.

No backdoor header was added — `.as()` (headers, for `app.inject`) is completely unchanged. The new
`.assemble()` deliberately returns a `Principal` object, not headers, because no HTTP request shape
exists that legitimately produces this principal — inventing one would have been exactly the backdoor
the ticket brief ruled out.

## 4. What was driven end to end, with results

Live run, `gaiada-test-cerbos` restarted immediately before (`2026-08-11T05:35:20Z`, `healthy`
confirmed), fresh per-file Postgres (`initTestDb()`):

| Kind / rule | Principal | Result | What it proves |
|---|---|---|---|
| `pm_task:read` | real `member`, OBO envelope, unverified link | **401/403** | erasure, not the floor (§1) |
| `POST /principal/resolve` | same unverified row | **200**, `{userId: real, assurance:"low", companies:[]}` | the asymmetry exists and is live (§1) |
| `agent_run:read` (IAM-SEC-01's floor) | real company_admin (run owner) @ `"high"` | **ALLOW** | smoke check — the rule isn't stale before trusting the DENY below |
| `agent_run:read` | SAME real owner @ `"low"` | **DENY** (`ForbiddenException`) | `notLow` holds for a REAL `assemblePrincipal()` output, not just a hand-typed literal (closes the specific gap `cerbos-agent-run.test.ts` left: that file already proved this with a synthetic `Principal`) |
| `agent_run:read` | same owner @ `"linked"` | **ALLOW** | floor excludes only `"low"`, not `"linked"` — unchanged from IAM-SEC-01's own suite, now reconfirmed against a real principal |
| `agent_run:read` | a different real user (`manager`) @ `"low"`, not the owner | **DENY** | low assurance doesn't accidentally open a non-owner path — additive-restrictive, not a replacement |
| `hr_case:read` (mainstream `inTenant && notLow`, no prior real-principal coverage) | real company_admin @ `"high"` | **ALLOW** | baseline |
| `hr_case:read` | SAME real company_admin, same tenant, same resource, only assurance changed | **DENY** | first live proof of a mainstream `notLow` rule against a REAL DB-backed principal, not a literal |
| `rollup:read` | real platform_admin (global role) @ `"low"` | **ALLOW** | confirms `rollup`'s `notLow` omission is real, not merely untested — a role-sufficient principal is never blocked by assurance here |
| `rollup:read` | real `member` (no platform_admin/group_executive/`perm_rollup_read`) @ `"high"` | **DENY** | control — the ALLOW above is the role, not a blanket bypass |
| `mcp_tool:call` | — | **not run** | see §5 — structurally out of reach from this repo |

## 5. `mcp_tool` — the third named exception, and why it could not be attempted here

`resource_mcp_tool.yaml`'s `request.principal.attr.assurance` uses a **different three-tier
vocabulary** than platform-nest's own `Assurance` type: `"anonymous"` / `"low"` / `"verified"`
(cross-checked against the policy file's own header comment), evaluated against a `hub_caller`-shaped
principal that **mcp-hub itself** constructs (`mcp-hub/src/principal.ts` — a different service, a
different repository). platform-nest's `check()`/`authorize()` (this file's only instrument) never
builds or sends that principal shape, and platform-nest's own `Principal.assurance`
(`"low"`/`"linked"`/`"high"`) is not the same enum as the one this policy reads. A test against
`resource_mcp_tool.yaml` written from platform-nest would be testing a policy file this service never
evaluates in production — driving it for real requires mcp-hub's own suite (that repo's header
references `mcp-hub/src/cerbos.test.ts` as already covering it). Documented as `it.todo(...)` in the
new file rather than either skipped silently or faked with a same-vocabulary substitute.

## 6. Coverage summary

**Now driven end to end, with evidence:**
- The exact mechanism by which `AuthGuard` cannot mint a named `"low"` principal (live HTTP proof,
  not inference).
- The `IdentityController.resolve()` / `AuthGuard` asymmetry on the identical unverified-link case
  (live HTTP proof of both sides).
- `agent_run:read`'s IAM-SEC-01 `notLow` floor, against a REAL `assemblePrincipal()`-produced
  principal (owner/non-owner × low/linked/high).
- `hr_case:read`'s mainstream `inTenant && notLow` rule, against a real principal, for the first time.
- `rollup:read`'s deliberate absence of a `notLow` floor, confirmed real (not merely undocumented) via
  a role-holding ALLOW and a role-lacking DENY control.

**Remains undriven, and why:**
- `mcp_tool:call`'s assurance gate — different service, different principal schema (§5). Out of
  platform-nest's reach entirely, not a scoping choice.
- **Whether `notLow` is reachable in a LIVE request today** — §2's finding is that it structurally is
  not, for any principal any current guard branch can produce. This is not "undriven" so much as
  "driven, and the answer is: not currently reachable in production traffic." Closing that gap for
  real (not just at the Cerbos-mechanics level Part 2 proves) requires either (a) fixing the
  `guards.ts`/`identity.controller.ts` asymmetry in the direction that lets a linked-but-unverified
  identity carry its real company data at `"low"`, or (b) introducing a step-up-expiry mechanism that
  downgrades an existing session's assurance without erasing its identity — both are production-
  behaviour changes outside this ticket's owned files, and are flagged here rather than made.

## 7. Files touched

- `platform-nest/src/testing/personas.ts` — additive: `PersonaTenant.assemble()`,
  `assemblePersonaPrincipal()`, doc comments. `.as()` and every existing export unchanged
  (`iam-verify-01.authz-drive.test.ts`'s full 29-test suite re-run green after this edit).
- `platform-nest/src/testing/iam-verify-02.low-assurance.test.ts` — new, 11 tests + 1 `it.todo`,
  4 describe groups.
- `docs/superpowers/plans/2026-08-11-iam-verify-02-report.md` — this report.

Nothing else. No policy, migration, controller, `principal.ts`, `guards.ts`, `oidc.ts`,
`identity.controller.ts`, `config.ts`, or existing test file was modified. The `AuthGuard`/
`IdentityController` asymmetry (§1) and `notLow`'s current unreachability in live traffic (§2) are
reported as findings for the guard/assurance-program owner, not fixed here.
