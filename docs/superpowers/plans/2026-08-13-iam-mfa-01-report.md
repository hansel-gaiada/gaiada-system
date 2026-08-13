# IAM-MFA-01 — the high-assurance tier reads a claim Keycloak never sends

**Status:** PROTOTYPED / DEV-VERIFIED (targeted suites + a live teeth-proof this session). **Not
deployed** — no commit, no push, per this ticket's constraint. The live realm at `gda-aicenter` is
untouched; `infra/runbooks/enable-mfa.md` is the not-yet-applied plan for that side.

## 1. Re-verified finding (live, read-only, this session — not assumed from the ticket text)

Read-only `psql` against `gaiada_keycloak` on `gda-aicenter` (`sudo -u postgres psql -d
gaiada_keycloak`, SELECT only, nothing written):

- `protocol_mapper` on `gaiada-ui`/`gaiada-platform`: exactly one row each, both
  `oidc-audience-mapper` (`gaiada-platform-audience`). No `amr` mapper anywhere.
- `realm_attribute` filtered on `acr`/`loa`: **0 rows** — no ACR-to-LoA map configured.
- `credential`: **17 `password`, 0 `otp`.**
- `authentication_execution`/`authentication_flow`: the `browser` flow's `forms` subflow already
  contains a `Browser - Conditional OTP` subflow (`conditional-user-configured` → `auth-otp-form`,
  both `CONDITIONAL`) — the OTP challenge machinery exists and needs no restructuring, it has simply
  never fired because nobody holds an OTP credential.
- `authentication/required-actions`: `CONFIGURE_TOTP` registered, `enabled: true`,
  `defaultAction: false` — self-service enrollment is possible today; nothing forces it.
- `platform-nest/src/auth/oidc.ts:95` (pre-fix): `assuranceFor()` → `"high"` only if
  `tok.amr` contains `mfa`/`otp`/`hwk`/`totp`; `:55` (pre-fix) collapsed an absent claim to `[]`
  with no record that it was ever absent.

All five points match the ticket's finding exactly, from a fresh read this session, not carried over.

## 2. Mechanism chosen: Keycloak's built-in AMR protocol mapper (`oidc-amr-mapper`), not ACR/LoA

Full tradeoff table and citations are in `infra/runbooks/enable-mfa.md` §2; the short version:

- **AMR** (`oidc-amr-mapper`, `AmrProtocolMapper`/`AmrUtils` source read directly from
  `keycloak/keycloak@main`) needs **zero flow restructuring** — the existing `Browser - Conditional
  OTP` subflow already does the right thing; the mapper just needs attaching to a client, and the
  existing OTP execution needs a reference value. The claim shape (`string[]`) is exactly what
  `VerifiedToken.amr`/`assuranceFor()` already expect.
- **ACR/LoA** would require editing the realm's **shared `browser` flow** — the one path every real
  human login, including `hansel@gaiada.com`'s, goes through — to insert a Level-of-Authentication
  conditional subflow, plus a realm ACR→LoA numeric map. That is real lockout-risk surgery for a
  three-tier signal the AMR path already satisfies more simply. Two additional, sourced reasons it
  loses: [keycloak/keycloak#15237](https://github.com/keycloak/keycloak/issues/15237) is an **open**
  bug where step-up via `acr_values` doesn't reliably drive the conditional subflow — the same
  "condition silently doesn't fire" failure shape this ticket exists to close, now in a mechanism
  with a known live instance of it; and the realm's client-level **"Minimum ACR value"** convenience
  option is a **26.1.0** feature ([release notes](https://www.keycloak.org/2025/01/keycloak-2610-released)),
  not present on the pinned live tag `quay.io/keycloak/keycloak:26.0`.

Verified against Keycloak 26 sources/docs via WebFetch/WebSearch this session (not recalled): the
`acr-to-loa-mapping.adoc` and `authentication/flows.adoc` pages, the `AmrProtocolMapper.java`/
`AmrUtils.java` source (confirming `PROVIDER_ID = "oidc-amr-mapper"` and, critically, that **the
claim is always set once the mapper is attached** — empty array for a plain login, never omitted —
which is the exact signal the platform-side fix in §3 depends on), and the 26.1.0 release notes.

## 3. Platform-side fix — `platform-nest/src/auth/oidc.ts`

Kept the three-tier contract (`"high" | "linked" | "low"`, `principal.ts`) completely unchanged — no
renames, no new tier. The fix is entirely inside `oidc.ts`:

- **`VerifiedToken`** gained `amrClaimPresent: boolean` alongside the existing `amr: string[]`.
  `verifyToken()` now sets `amrClaimPresent = Array.isArray(p.amr)` and only trusts `p.amr` as the
  real claim when that's true — an absent or non-array `amr` no longer silently becomes the same
  empty array a genuine password-only login produces.
- **`assuranceFor()`**: if `!tok.amrClaimPresent`, it still returns `"linked"` (fail-closed — never
  invents `"high"`), but now also increments an exported counter (`getAmrClaimMissingCount()`) and
  `console.error`s a tagged, greppable line (`[oidc:amr-claim-missing]`) naming the `sub`, the
  reason, and pointing at this runbook. A genuinely present-but-empty claim (`amr: []`, a real
  weak-auth login once the mapper is wired) takes neither path — it's the ordinary `"linked"` case,
  silent, exactly as before.

This is the actual deliverable per the ticket's own framing: the claim swap alone would just move
the identical silent-default trap onto a new claim name. The `amrClaimPresent` distinction is what
makes a **future** misconfiguration (mapper detached from a client, a fresh realm import that
forgets it, a new client added without it) show up as a loud, countable, per-`sub` log line on the
very first affected login, instead of a permanent, silent cap discoverable only by an audit.

## 4. Teeth proof — driven live this session, not asserted

1. `npx vitest run src/auth/oidc.test.ts` (fixed code): **11/11 passed**, `getAmrClaimMissingCount()`
   asserted to increment exactly on the absent/malformed cases and NOT on the present-but-empty case;
   `console.error` spy asserted called/not-called correspondingly.
2. **Broke it on purpose**: edited `verifyToken()`'s `amrClaimPresent` computation to the hardcoded
   `true` (i.e., reverted to the pre-fix conflation where "absent" and "present" are indistinguishable)
   and re-ran the identical suite: **5/5 of the relevant tests went red** — 3 pre-existing tests that
   don't set `amr` at all (`Cannot read properties of undefined (reading 'some')`, since `tok.amr` was
   never populated once `amrClaimPresent` lied about its presence) plus 2 of the 4 new IAM-MFA-01
   tests (the "absent" and "malformed" cases). This is a harder failure than the original silent bug
   (a crash instead of a silent wrong answer) precisely because the old code's
   `Array.isArray(p.amr) ? p.amr : []` guard had been doing double duty as both the presence check
   and a crash-guard — removing it without also handling the split correctly breaks louder than the
   original defect did, which is itself informative about why the two concerns needed separating.
3. Restored the real fix from the pre-edit copy; re-ran: **11/11 passed** again, confirmed byte-for-
   byte identical to the version reported in §3.

## 5. Gates — this session, real output

| Gate | Result |
|---|---|
| `npx vitest run src/auth/oidc.test.ts` | **11/11 passed** (7 pre-existing + 4 new IAM-MFA-01 tests) |
| Full `src/auth/` (only file: `oidc.test.ts`) | 11/11 — same run, no other test file exists under `src/auth/` |
| Full `src/rbac/` (24 files, live `gaiada-test-cerbos`) | **574/574 passed** — identical to the 574/574 baseline in `docs/superpowers/plans/2026-08-13-iam-04-reg3-report.md` §6 (this ticket touches zero `src/rbac/` files, zero Cerbos policy files, so an unchanged count is the expected and confirmed result, not an assumption) |
| `npm run typecheck` | 0 errors, both before the teeth-break and after restoring the fix |
| Teeth-proof (§4) | 5/5 relevant tests **red** on the broken variant, all green again after restore |

No full `npm test` was run, per the ticket's constraint (shared test-Cerbos container) — only the
suites named above. `DATABASE_URL_TEST`/`CERBOS_URL` were pointed at the already-running
`gaiada-test-pg` (port 55433) / `gaiada-test-cerbos` (ports 3592-3593) containers for this session;
no new test infrastructure was started or stopped.

## 6. Runbook — ordering and lockout-safety reasoning

`infra/runbooks/enable-mfa.md`, not applied. Order, and why it can't lock `hansel@gaiada.com` out:

1. **Rollback point** — `kcadm.sh create realms/gaiada/partial-export`, same convention
   `docs/runbooks/idp-keycloak.md`'s own PR-00b/SEC-02 entries already use on this realm.
2. **Add the AMR mapper** to `gaiada-ui` (the client `sso-login.sh` and the real UI use) and
   `gaiada-platform` — purely additive; with no execution carrying a reference value yet, it emits
   `amr: []` for every login, which is the platform's own "legitimate empty claim" case. Verified
   immediately with a live login + JWT decode, before touching anything else.
3. **Set a reference value** on the existing `auth-otp-form` execution inside `Browser - Conditional
   OTP` — still additive; the execution's `CONDITIONAL`/`conditional-user-configured` gating is
   untouched, so it still only challenges users who already hold an OTP credential (today: nobody).
4. **Enroll `hansel@gaiada.com`'s own OTP credential** via the self-service Account Console
   (`/idp/realms/gaiada/account`) — no realm required-action flip needed, `CONFIGURE_TOTP` is already
   enabled (just not default). Confirmed read-only afterward via `kcadm get users/.../credentials`.
5. **Drive a real login for `hansel@gaiada.com`** and verify **both** sides: decode the raw token for
   `"amr": ["otp"]`, and call `GET /api/me` (`core.controller.ts:34`, echoes
   `req.principal.assurance` verbatim) for `"assurance": "high"`. This is the concrete, driven proof
   the tier is reachable, gated behind nothing but self-service enrollment, and it happens entirely
   before any realm-wide requirement changes.
6. **Realm-wide `defaultAction: true` on `CONFIGURE_TOTP`** is called out as a separate, owner-decided
   step, explicitly not auto-chained after step 5 — it's the one step that changes what the other ~6
   real logins see, so it gets its own deliberate go/no-go rather than being bundled into "enable
   MFA" as one atomic action.
7. **Fresh-boot parity** (`infra/compose/keycloak/gaiada-realm.json`) is flagged, not edited — same
   disposition `docs/runbooks/idp-keycloak.md` (PR-00b) already used for the analogous
   `UPDATE_PASSWORD` gap: real, worth fixing, out of this ticket's file scope.

Every step through 5 is additive or self-service; nothing an existing password-only login depends on
changes until step 6, which is explicitly gated on an owner decision made *after* step 5's proof.

`sso-login.sh` cannot complete step 5's verification on its own once OTP is enrolled (it has no OTP
form step — confirmed by reading it: its own error message anticipates "an interstitial such as
OTP/consent" and gives up rather than handling it), so the runbook uses a real browser for that one
login, mirroring the same method `docs/runbooks/idp-keycloak.md`'s SEC-01/PR-00b entries already
used for equivalent Keycloak-flow checks on this realm.

## 7. What's left to an owner decision

- **Whether/when to flip `CONFIGURE_TOTP` to `defaultAction: true`** (runbook §3.6) — a real UX
  change for the other ~6 real logins, not mine to schedule.
- **Whether to mirror the mapper/reference-value into `infra/compose/keycloak/gaiada-realm.json`**
  (runbook §3.5) now or as a separate follow-up — flagged, not edited, consistent with this file
  being outside this ticket's owned-files list.
- **Whether to wire `getAmrClaimMissingCount()` into a boot/health/metrics endpoint** — the counter
  and the per-occurrence log line exist now (`oidc.ts`), but actually alerting on it means touching a
  file outside `src/auth/` (e.g. `main.ts`'s health surface or an admin-systems endpoint), which is
  outside this ticket's owned files (`src/auth/oidc.ts`, its tests, this report, the runbook).
- **Whether the runbook's §3.1 console-alternative field labels match the operator's actual Keycloak
  26.0 build byte-for-byte** — the exact reference-value field label was not pinned with full
  confidence from documentation alone (Keycloak's own docs title the *capability*
  "Adding an authenticator reference value" but the search tooling available this session could not
  quote the console's literal field text verbatim); the runbook treats the live probe in its own
  §3.4 as the source of truth rather than the field's exact wording, but an operator hitting an
  unexpected label should treat that as expected version drift, not a sign the runbook is wrong.

No other blockers. `src/auth/oidc.ts`, `src/auth/oidc.test.ts`,
`infra/runbooks/enable-mfa.md`, and this report are the only files touched this session; the tree
otherwise remains exactly as it was left by the concurrent session (`VERSION`, `docs/modules/*`,
`docs/blueprints/smm-*`, `docs/plans/2026-08-12-full-bug-audit.md` — all untouched, per the ticket's
instruction).
