# Runbook — Keycloak IdP (5b.2)

Self-hosted OIDC identity provider. The platform verifies its tokens (5b.1); Cerbos and the
platform never see passwords. Provider-agnostic (JWKS + issuer), so a Zitadel swap is config.

## Local / VPS bring-up

```bash
cd infra/compose
# .env: KEYCLOAK_ADMIN_PASSWORD=<random>, keep PLATFORM_AUTH_MODE=dev until MFA is set up
docker compose -f docker-compose.vps.yml up -d keycloak
```

Keycloak listens on 127.0.0.1:8080 (localhost only; tunnel in). Admin console → create the
realm and clients (below), then flip `PLATFORM_AUTH_MODE=oidc` and restart the platform.

## Realm `gaiada` — required config

- **Realm:** `gaiada`.
- **Client `gaiada-platform`** (confidential, for the API): audience must include
  `gaiada-platform` (add an audience mapper), standard flow on. This is `OIDC_AUDIENCE`.
- **Client for the web UI** (public, PKCE) when WS5 lands.
- **Roles** (realm roles): `platform_admin`, `group_executive`, `company_admin`, `manager`,
  `member`, `viewer`, `agency_approver`. Map role scopes to the platform's `user_roles` via an
  admin sync job (or assign platform roles directly; Keycloak roles inform, the platform's
  `user_roles` table is authoritative for scope).
- **Email verification: REQUIRED.** The platform refuses to link a new IdP subject to an
  existing account unless `email_verified=true` (account-takeover guard, oidc.ts). Turn on
  "Verify Email" in realm login settings.
- **Token lifespan:** set access-token TTL to ~1–5 minutes (D11 — short TTL + the platform's
  session-version deny-list give near-immediate revocation). Refresh tokens carry the session.
- **MFA:** require OTP (or WebAuthn) — an MFA'd session carries `amr` including `otp`/`mfa`,
  which the platform maps to `assurance:high` (unlocks step-up-gated sensitive actions, D4.3).

## Bootstrap script (optional)

`kcadm.sh` one-liners to create the realm/client/roles live in this runbook's git history;
re-run them against a fresh Keycloak to reproduce. A realm-export JSON can be dropped in
`infra/compose/keycloak/` for `--import-realm` on first boot once finalized.

## SMTP (MAIL-03) — realm mail against the Mailpit dev sink

The realm sends mail (forgot-password, verify-email, and any future required-action email)
through the SMTP config on `realms/gaiada.smtpServer`. Dev default points at the Mailpit sink
that ships with the `mail-dev` compose profile: host `mailpit`, port `1025`, from
`no-reply@auth.gaiada.invalid`, no auth, no TLS — the sink is authless/plaintext by design and
loopback-only for its UI/API (`127.0.0.1:8025`), never internet-exposed.

**ex-Q-V6 — settled, dev-provable (2026-08-04): realm-import does NOT substitute `${env.*}`
placeholders.** Verified by importing a throwaway realm
(`zzz-smtp-placeholder-test`) whose `smtpServer.host` was literally `"${env.ZZZ_TEST_SMTP_HOST}"`
with that env var actually set and passed through the keycloak service's `environment:` block.
After `--import-realm` ran, `kcadm.sh get realms/zzz-smtp-placeholder-test` showed the field
**unexpanded** — the literal placeholder string, not the env value. Keycloak's
`DirImportProvider`/`ExportImportUtil` import path performs no property/env substitution on the
realm JSON, in this version (`quay.io/keycloak/keycloak:26.0`, resolved `26.0.8`) or generally.
The test realm and probe file were deleted after the check; no permanent state was left behind.

**Consequence for `gaiada-realm.json`:** its committed `smtpServer` block holds real, working dev
values (the Mailpit shape above), not `${env.KC_SMTP_*}` placeholders — shipping literal
placeholder strings would have made a fresh realm's SMTP config literally try to connect to a
host named `${env.KC_SMTP_HOST}`, which is strictly worse than an honest default.

**Fresh-boot path (works today):** the default import already gives a fresh box a working
sink-backed SMTP config with zero extra steps. If you need something other than the default
(a different sink port, or in staging a real relay), set `KC_SMTP_HOST`/`KC_SMTP_PORT`/
`KC_SMTP_FROM`/`KC_SMTP_FROM_DISPLAY_NAME`/`KC_SMTP_AUTH`/`KC_SMTP_SSL`/`KC_SMTP_STARTTLS` in
`.env` (same names the keycloak service's `environment:` block already passes through — the
compose-passthrough trap: setting them only in `.env` does nothing extra beyond making them
visible inside the container; the container seeing them still does not touch the realm), then run:

```bash
docker exec -e KEYCLOAK_ADMIN_PASSWORD=<admin pw> gaiada-keycloak-1 \
  bash /opt/keycloak/data/import/configure-smtp.sh
```

`infra/compose/keycloak/configure-smtp.sh` is bind-mounted in at `/opt/keycloak/data/import/`
(same mount as the realm JSON) — it re-reads the container's own `KC_SMTP_*` env and pushes it via
`kcadm update realms/gaiada -s smtpServer.*`. Idempotent; re-run any time the values change (import
never picks up a change on its own — the realm already exists after first boot, so
`--import-realm` skips it on every later restart).

**Live-configured on gda-aicenter 2026-08-04** via one-off `kcadm.sh update` against the running
container (this is what `configure-smtp.sh` now automates for future boots); confirmed to survive
a `docker compose ... up -d --force-recreate keycloak` (smtpServer is DB-persisted state, not
import-derived, so a container restart never loses it).

### Real auth-flow evidence (dev-verified against the sink, 2026-08-04)

Both the forgot-password and verify-email flows were driven end-to-end against the live
`erp.gaiada.online/idp` realm (real HTTP requests through nginx, real PKCE authorization-code
flow, real Mailpit API capture, real link click, real token issuance) using disposable dev users
(`mail03-forgot@dev.gaiada.invalid`, `mail03-verify@dev.gaiada.invalid`; both deleted after):

- **Forgot password:** submitted via `login-actions/reset-credentials`, captured a "Reset
  password" mail in Mailpit, clicked the emailed action-token link, and received a real Bearer
  access token from the token endpoint off the resulting authorization code (`acr:1`, valid
  `account` REST profile fetch). **Finding worth flagging** (not a MAIL-03 blocker): the realm's
  "reset credentials" flow's "Reset Password" execution is configured `REQUIRED` but the observed
  live behavior authenticates and completes without presenting an inline new-password form when
  the user already holds a password credential and no `UPDATE_PASSWORD` required action is queued
  — reproduced identically under both the `account-console` and `gaiada-ui` clients, so it is flow
  behavior, not a client artifact. Worth a follow-up look at the flow config if self-service
  in-band password replacement (not just re-authentication) is required later.
- **Verify email:** created a user WITHOUT `emailVerified:true`, added the `VERIFY_EMAIL` required
  action, logged in with a real password — Keycloak gated on the required action and sent the
  "Verify email" mail (captured in Mailpit), clicked the link, and the required-action redirect
  chain completed to a real authorization code / Bearer token. `kcadm get users/<id>` confirmed
  `emailVerified` flipped `false → true` purely through this flow.

### SEC-01 (2026-08-06, QA) — CONFIRMED: the reset-password link is a login link, not a rotation link

Re-tested MAIL-03's finding above with a **real Chromium browser** (Playwright), not curl/PKCE,
specifically to rule out a headless artefact. Throwaway user `sec01-throwaway@dev.gaiada.invalid`
(password `OldPassw0rd!SEC01`, `emailVerified:true`, no required actions), created/deleted via
`kcadm.sh` against `gaiada-keycloak-1`; mail captured through the SSH-tunnelled Mailpit API
(`127.0.0.1:8025`).

**Verdict: CONFIRMED, not a curl artefact — the browser behaves identically.**

- **What rendered:** clicking the emailed action-token link, in the same browser session that
  requested it, landed **directly on an authenticated page with zero `<input type="password">`
  fields** — the account console (`.../idp/realms/gaiada/account`, full profile page) under
  `account-console`, and the full staff ERP shell (`https://erp.gaiada.online/`, nav + "Good
  morning, sec01-throwaway@dev.gaiada.invalid") under `gaiada-ui`. No inline new-password form at
  any point, under either client.
- **The decisive test — old password after the "reset":** in a **fresh browser context** (no
  cookies from the reset), signing in with the **original** password (`OldPassw0rd!SEC01`)
  succeeded outright under both `account-console` and `gaiada-ui`, landing on the authenticated
  page each time. The password was never rotated.
- **kcadm confirms no rotation happened:** `GET users/<id>/credentials` after the flow shows
  exactly **one** password credential, `createdDate` matching the original `set-password` call
  (pre-reset) — no second credential was ever created. `requiredActions` stayed `[]` throughout;
  Keycloak never queued `UPDATE_PASSWORD`.
- **Flow config read (read-only, unchanged):** realm `resetCredentialsFlow` → `"reset credentials"`.
  That flow's executions: Choose User (REQUIRED) → Send Reset Email (REQUIRED) → **Reset Password
  (REQUIRED, providerId `reset-password`)** → Reset - Conditional OTP (CONDITIONAL, not configured
  for this user so it's skipped). The "Reset Password" execution is REQUIRED in configuration, yet
  the live flow never presented it for this account (has a password credential already, no
  `UPDATE_PASSWORD` required action pending) — Keycloak's `reset-password` authenticator treats
  itself as already-satisfied in that case and falls through, ending the flow at
  re-authentication instead of forcing a change.
- **Browser vs. curl:** identical. MAIL-03's headless/PKCE walk was not an artefact — this is real
  flow behavior, reproduced with a real browser end to end, under both clients.

**Security consequence, restated:** possession of the mailbox → click the link → land in an
authenticated session, with the original credential still valid afterward. Same "bearer
credential sitting in an inbox" shape that decision M11 explicitly forbids for approval links.
The email is not a self-service password-rotation mechanism in its current form; it is a
password-equivalent bearer link with an unusually long blast radius (whoever reads that one email
can sign in indefinitely afterward, since nothing was invalidated).

**Recommendation (no fix implemented — out of scope for this ticket):** the likely correct shape,
to confirm with a Keycloak-version-aware follow-up, is to stamp `UPDATE_PASSWORD` as a required
action when *issuing* the reset-credentials email (or switch the "Reset Password" execution's
semantics so it does not self-satisfy against an existing credential), so the flow cannot complete
without the user setting a new password. This is a realm/flow-config change, not a platform-code
change — route it to whoever owns Keycloak realm config (senior-integrator / devops), and re-run
this same browser-based test after any change, since the current live behavior is easy to
mistake as fixed from config inspection alone (the execution already reads REQUIRED).

Throwaway user deleted and confirmed absent (`kcadm get users -q email=...` returned `[]`) after
the test; no realm/flow config was modified.

### SEC-02 (2026-08-06, senior-integrator) — root-caused: a documented Keycloak core interaction,
### not a realm-config defect. No fix applied; flagged for the architect.

Ticket: make the reset email actually rotate the password. Guardrail was to work through SEC-01's
four hypotheses in order and **stop with a precise diagnosis** rather than ship an unverified
change to a live auth flow. Realm exported first (rollback point, see below); worked entirely
against a second throwaway user (`sec02-throwaway@dev.gaiada.invalid`), created and deleted via
`kcadm.sh`; mail captured through the same Mailpit API route as SEC-01 (the SSH session to
`gda-aicenter` itself *is* the tunnel — Mailpit is loopback-only on the box).

**Realm export (rollback point):** `~/gaiada-realm-backups/gaiada-realm-export-20260806-030015.json`
on `gda-aicenter` (74,678 bytes; `kcadm.sh create realms/gaiada/partial-export -q
exportClients=true -q exportGroupsAndRoles=true`). No realm/flow config was changed this session,
so this export was never needed as a rollback — it exists purely as the required checkpoint.

**Hypothesis 1 (wrong nesting level) — RULED OUT.** The partial export's
`authenticationFlows[].authenticationExecutions[]` array is unambiguous: `reset-password`
(priority 30, `requirement: REQUIRED`) sits directly under the **top-level** `reset credentials`
flow, as a sibling of `reset-credentials-choose-user` (10) and `reset-credential-email` (20), with
only the OTP step (priority 40) wrapped in a `CONDITIONAL` subflow reference. No ALTERNATIVE/
DISABLED parent is swallowing it.

**Hypothesis 2 (wrong flow bound) — RULED OUT.** The realm's `resetCredentialsFlow` attribute is
literally `"reset credentials"`, and the export contains exactly one `topLevel: true` flow with
that alias (`id 9dc059a9-...`). No duplicate/similarly-named flow exists to be shadowing it.

**Hypothesis 3 (link/token-type artefact) — RULED OUT, and more precisely than SEC-01 could show.**
Decoded the actual action-token JWT from a captured mail: `typ: "reset-credentials"`, correct
`azp` (`account-console` / `gaiada-ui` per client), and an `asid` claim that ties the token back to
the *specific authentication session* created when the reset was requested. That raised a sharper
version of hypothesis 3: is the short-circuit an artefact of the **requesting** browser's session
(e.g. some stale continuity), rather than the link itself? Tested directly — clicked the emailed
link in a **brand-new, cookie-less Playwright browser context** that never touched the requesting
session (confirmed zero relevant cookies beforehand: only session-tracking `AUTH_SESSION_ID`/
`KC_RESTART`, no identity cookie). **Identical result:** "Your account has been updated," zero
`<input type=password>` fields, under both `account-console` and `gaiada-ui`. The action token
carries the session reference in its own signed payload (`asid`), so Keycloak resumes that
server-side auth session regardless of which device/browser redeems it — by design, the same way
every mailed action link works. This rules out "browser artefact" as the mechanism; the
short-circuit is intrinsic to the flow/token processing itself, not to session continuity.

**Hypothesis 4, confirmed — but more precisely than "the authenticator short-circuits."** Pulled the
actual Keycloak 26.0.8 source (the exact tag running in `quay.io/keycloak/keycloak:26.0`) for the
two classes in the completion path:

- `org.keycloak.authentication.authenticators.resetcred.ResetPassword#authenticate()` — confirmed
  it does the *correct* thing for our config: since the execution `isRequired()`, it calls
  `context.getAuthenticationSession().addRequiredAction(UserModel.RequiredAction.UPDATE_PASSWORD)`
  before `context.success()`. **The authenticator is not silently skipping anything** — it queues
  `UPDATE_PASSWORD`, just onto the *authentication session*, not onto the persisted `UserModel`
  (which is exactly why `kcadm get users/<id> --fields requiredActions` keeps reading `[]`
  throughout — that field only ever reflected the persisted side).
- `org.keycloak.authentication.actiontoken.resetcred.ResetCredentialsActionTokenHandler` — the
  action-token handler that runs the flow to completion calls a custom
  `ResetCredsAuthenticationProcessor` subclass whose `authenticationComplete()` falls through to
  the base `AuthenticationProcessor#authenticationComplete()` → `nextRequiredAction()` →
  `AuthenticationManager.nextRequiredAction(...)`, which is supposed to notice the queued
  session-level `UPDATE_PASSWORD` and redirect into its challenge form before finishing.

That last hop is a **documented, still-open upstream Keycloak behavior**, not something expressible
in our realm JSON: [keycloak/keycloak#16527](https://github.com/keycloak/keycloak/discussions/16527)
traces the exact same symptom (a `ResetPassword`-queued session-level required action getting lost
relative to user-level ones in this same action-token completion path) to
`AuthenticationManager.nextRequiredAction` not applying the same priority-sort to session-level
required actions that it applies to user-level ones — confirmed by the thread's own author needing
to **patch Keycloak's Java source** to fix it, then settling instead on **writing a custom
authenticator** to replace `reset-password` outright ("the simplest solution is the best solution").
Two upstream-proven fixes exist, and both are code changes to Keycloak itself, not realm config:
patching `AuthenticationManager` core-wide (blast radius: every required-action resolution on the
realm, not just password reset), or shipping a custom SPI authenticator to replace the
`reset-password` provider in our flow (narrower, but still a Java provider that has to be built
into and mounted in the Keycloak image — no build/test pipeline for that exists in this repo, unlike
our own Go/Node services' `wsl.ps1` path). [keycloak/keycloak#40744](https://github.com/keycloak/keycloak/issues/40744)
is a related-looking but **different** bug (immediate auth from a *misconfigured* flow with the
email/reset-password steps removed entirely) — checked and excluded; our flow's executions are all
present and `REQUIRED`, confirmed by the export above.

**A config-only alternative was considered and rejected as out of scope, not because it's unsafe:**
stamping `UPDATE_PASSWORD` on the persisted `UserModel` (not the session) at the moment the reset
is *requested* would sidestep the ordering bug entirely, since user-level required actions ARE
correctly honored by `nextRequiredAction()`. But there is no code seam to attach that to — both
`account-console` and `gaiada-ui` hit Keycloak's own native "Forgot Password?" link directly; no
platform-nest code sits in that path today. Keycloak's admin API has a purpose-built mechanism for
exactly this shape — `PUT /admin/realms/{realm}/users/{id}/execute-actions-email` with
`["UPDATE_PASSWORD"]`, which queues the required action on the persisted user and does not go
through the buggy session-ordering path at all — but adopting it means routing self-service
password reset through a new platform-nest-owned endpoint (with its own anti-enumeration
requirements) instead of Keycloak's native flow, and/or disabling `resetPasswordAllowed`. That is
an architecture decision (who owns "forgot password," not just how the flow is configured), not a
flow-config fix, so it is **flagged for the architect**, not implemented here.

**Verification performed (real, driven, not inferred):**
- Old password (`sec02-throwaway`, both a special-character and a plain password were tried across
  two `set-password` cycles) **still authenticated successfully** after the "reset," in a fresh
  browser context, under both `account-console` (landed on `/idp/realms/gaiada/account/`) and
  `gaiada-ui` (landed on the full authenticated ERP shell at `/`) — reproducing SEC-01's finding
  independently, from a from-scratch throwaway user.
- `kcadm get users/<id>/credentials` after the "reset": exactly one password credential, unchanged
  `createdDate`. `requiredActions` (persisted): `[]` throughout.
- **Normal-login / lockout check:** signed in as an existing, untouched dev user
  (`design@gaiada-creative.test`, the shared dev password) via ordinary `gaiada-ui` SSO — landed
  authenticated on the full staff shell. Expected, since no realm/flow config was touched this
  session, but driven for real per the guardrail rather than assumed.
- Throwaway user `sec02-throwaway@dev.gaiada.invalid` deleted; `kcadm get users -q email=...`
  returned `[ ]` afterward.
- Four-project survival re-checked post-session: `gaiada` (keycloak untouched at its pre-session
  uptime, mailpit/clamav healthy), `gaiada-alertmanager`, `gaiada-automation` (n8n), and
  `gaiada-otel-metrics` all still `Up`.

**Net: no fix applied.** Config inspection alone would have missed this the same way it missed
SEC-01 — the flow reads REQUIRED, the authenticator's own source shows it queuing the right
required action, and the bug only surfaces in how a downstream, undocumented-at-the-realm-level
completion path resolves session-scoped vs. user-scoped required actions. The old-password test
remains the only real check. **Blocked on an architect decision**: patch-Keycloak-core vs.
custom-SPI-authenticator vs. move self-service password reset to a platform-nest-owned
admin-API-mediated endpoint (which also changes who owns "forgot password" for the whole
platform). Re-run this exact browser-driven test (old password must stop working, new-password form
must render, under both clients) after whichever path is chosen.

### PR-00 (2026-08-06, senior-integrator) — REFUTED (as currently configured): `execute-actions-email`
### does not rotate the password either, and for a different, DIFFERENT-LOOKING reason than #16527

Ticket: browser-prove the SEC-03 design's load-bearing hypothesis — that admin
`execute-actions-email` with `UPDATE_PASSWORD` sidesteps the native reset-credentials bug
(SEC-01/SEC-02, upstream keycloak/keycloak#16527) because its handler
(`ExecuteActionsActionTokenHandler`) runs no authentication flow at all. Source reading (design
§2) said WRONG-in-mechanism/RIGHT-in-consequence; this ticket exists because "the same realm read
correctly configured for weeks" before SEC-01 caught the first bug from config alone.

**Method:** throwaway user `pr00-throwaway@dev.gaiada.invalid` (`emailVerified:true`, password
`OldPassw0rd!PR00`, no required actions), created/deleted via `kcadm.sh` against
`gaiada-keycloak-1`. Triggered `PUT .../users/{id}/execute-actions-email?lifespan=900` with
`["UPDATE_PASSWORD"]` via the `gaiada-provisioner` service-account client (client-credentials
grant, `manage-users`), once with `client_id=gaiada-ui` and once with `client_id=account-console`.
Mail captured via Mailpit's API on-box (`127.0.0.1:8025`); links driven with a real headless
Chromium via Playwright (`@playwright/test`, run from `platform-ui/node_modules`), each click in a
brand-new, cookie-less browser context.

**Verdict: REFUTED, as the realm is currently configured — but not a repeat of #16527. A precise,
different, and apparently fixable root cause was found in Keycloak's own log, not inferred.**

**The four pass conditions, each proven separately:**

1. **New-password form renders — FALSE.** Both runs (gaiada-ui and account-console `azp`)
   produced: mail → link → a confirmation interstitial ("Perform the following action(s): Update
   Password » Click here to proceed", the documented scanner-prefetch protection, confirmed
   present) → clicking through went **directly** to "Your account has been updated." **Zero**
   `<input type="password">` fields ever appeared, under either client. Screenshots captured at
   every step.
2. **Original password no longer works, fresh context — FALSE (the decisive one).** After BOTH
   execute-actions runs completed, a fresh cookie-less Playwright context signed in with the
   **original** password (`OldPassw0rd!PR00`) and succeeded outright: under `account-console`,
   landed on the real Account Management console (`.../idp/realms/gaiada/account/`, valid auth
   code + `session_state` on the URL); under `gaiada-ui`, landed on the full authenticated ERP
   shell at `/` with the throwaway user's email in the nav. Same shape as SEC-01/02.
   `kcadm get users/{id}/credentials` before and after both runs shows **exactly one** password
   credential, **identical `id` (`c0a7cf76-...`) and `createdDate`** throughout — never touched.
3. **No session minted on completion — TRUE (this part of the design holds).** Unlike SEC-01/02's
   native-flow finding (which granted a live authenticated session), the execute-actions
   completion page mints **no** app/account session: reusing the completed flow's own
   `storageState`, a fresh navigation to `/idp/realms/gaiada/account/` and to `/` both redirected
   to their respective login pages. Only cookie present post-flow: `AUTH_SESSION_ID` (httpOnly,
   Keycloak's own flow-tracking cookie, not an identity session).
4. **Single-use — FALSE, as a direct consequence of (1) never completing.** Re-clicking the
   identical `gaiada-ui` link in a third fresh context reproduced the **exact same** interstitial →
   "account updated" sequence again (not an invalid/expired error page). Consistent with the
   design's own documented caveat that an execute-actions token is "re-clickable until the action
   completes" (`UpdatePassword.isOneTimeAction()` never fires if the required-action provider
   never runs) — so this isn't a contradiction of the design, it's the same root cause surfacing
   a second way.

**The root cause — found in the container's own log, not inferred from config:**
```
WARN  [org.keycloak.services.managers.AuthenticationManager] Could not find configuration for
Required Action UPDATE_PASSWORD, did you forget to register it?
```
`kcadm get authentication/required-actions -r gaiada` confirms why: the realm's registered
required actions are exactly `CONFIGURE_TOTP` (enabled), `VERIFY_EMAIL` (enabled), and
`delete_account` (disabled). **`UPDATE_PASSWORD` is not registered at all** — not present, not
merely disabled. `AuthenticationManager.nextRequiredAction()` can't find a provider for an alias
that isn't registered on the realm, so it treats the token's action as vacuously satisfied and
falls straight through to the `END_AFTER_REQUIRED_ACTIONS` info page. Every symptom above (no form,
no rotation, re-clickable) is explained by this one gap.

**Why this is not the same finding as SEC-01/SEC-02, and matters differently to the architect:**
#16527 is a Keycloak **core** ordering bug with no realm-config fix (hence "custom SPI / core
patch" as the only real alternatives). This is a **realm required-actions registration gap** —
Authentication → Required Actions in the admin console (or
`kcadm create authentication/required-actions -r gaiada -s alias=UPDATE_PASSWORD -s
providerId=UPDATE_PASSWORD -s enabled=true -s name="Update Password"`), a config surface distinct
from `authenticationFlows`/`resetPasswordAllowed`. **This ticket did not touch it** — the
guardrail was "change nothing else," and enabling a required action is exactly the kind of realm
auth-config change this ticket was scoped to observe, not perform. That is precisely why the
verdict is "REFUTED as configured," not "REFUTED, mechanism dead": whether
`ExecuteActionsActionTokenHandler`'s claimed disjoint-code-path behavior actually holds **has not
been observed yet**, because the flow never got far enough to exercise it. The `AuthenticationManager`
merge-of-session-and-user-level-required-actions claim (design §2 table, row 3) is also unconfirmed
by this run for the same reason.

**Both-clients comparability (direct parity with SEC-01/SEC-02's method):** identical outcome
under `account-console` and `gaiada-ui` for all four conditions — interstitial renders, form never
does, completion page is the generic info page under both, original password authenticates
successfully under both post-flow. This rules out a client-specific artifact; the gap is realm-wide.

**Interstitial + lifespan, as asked:** the confirmation interstitial (fresh/no-matching-session
click) reproduced exactly as the design predicted, before either the form or the fallthrough.
**900s lifespan honoured** — decoded the mailed action-token JWT directly: `exp - iat = 900`
exactly (`1785994754 - 1785993854`), and the mail text says "This link will expire within 15
minutes," matching the explicit `lifespan=900` query param, not the realm's 12h default.

**Recommended next step (NOT performed here, architect's call):** register `UPDATE_PASSWORD` as
an enabled required action on the realm (one `kcadm create authentication/required-actions` call,
reversible) and **re-run this exact test** before trusting §2 of the SEC-03 design either way. If
the form then renders and the credential then rotates, the disjoint-code-path hypothesis is
confirmed after all and the only gap was a missing one-line realm registration (not a design
defect). If it still doesn't rotate even with the required action registered, the design is truly
void and PR-01..07 stay parked pending the custom-SPI/core-patch reopen per §4.

**Verification performed (real, driven, not inferred):** two independent execute-actions-email
dispatches (different `client_id`), each mail captured from Mailpit's real API, each link driven
by a real headless-Chromium Playwright context (fresh per step, never reused across a
different check), `kcadm` credential/required-action state read before and after. Throwaway user
`pr00-throwaway@dev.gaiada.invalid` deleted; `kcadm get users -q email=...` returned `[]`
afterward. Four-project survival (`gaiada`, `gaiada-alertmanager`, `gaiada-automation`,
`gaiada-otel-metrics`) reconfirmed post-session, `gaiada-platform-1` untouched at its
pre-session `StartedAt`/healthy state; disk unchanged at 76%. No realm/flow config was changed.

### PR-00b (2026-08-06, senior-integrator) — REGISTERED `UPDATE_PASSWORD`: BOTH paths now rotate.
### SEC-02's #16527 diagnosis was wrong as an explanation for the live symptom (the gap was a
### missing realm registration); PR-01..PR-07 should be CANCELLED, not reduced.

Ticket: register `UPDATE_PASSWORD` as a required action on the realm (PR-00's own recommended
next step) and re-run **both** PR-00's execute-actions-email test and SEC-01's native
reset-credentials test, to answer whether the eight-ticket PR-01..07 replacement program is still
necessary. Guardrail: registering the required action was the *only* config change authorized —
no flow edits, no `resetPasswordAllowed` change.

**Realm export (rollback point):**
`~/gaiada-realm-backups/gaiada-realm-export-20260806-053804.json` on `gda-aicenter` (74,678 bytes,
identical size to SEC-02's — nothing had changed in between). Never needed as a rollback; the one
change made (register a required action) was intentional, expected-behavior-changing, and is
easily reversible via `kcadm delete authentication/required-actions/UPDATE_PASSWORD -r gaiada` if
ever needed.

**Required-actions list, before:**
```json
[
  {"alias":"CONFIGURE_TOTP","enabled":true,"defaultAction":false,"priority":10},
  {"alias":"VERIFY_EMAIL","enabled":true,"defaultAction":false,"priority":50},
  {"alias":"delete_account","enabled":false,"defaultAction":false,"priority":60}
]
```

**Change made:** `kcadm create authentication/register-required-action -r gaiada -s
providerId=UPDATE_PASSWORD -s name="Update Password"`. Registered as **enabled, `defaultAction:
false`** — matching the realm's existing pattern (neither `CONFIGURE_TOTP` nor `VERIFY_EMAIL` is a
default action either; new users are not made to change their password on next login just because
the provider now exists on the realm).

**Required-actions list, after:**
```json
[
  {"alias":"CONFIGURE_TOTP","enabled":true,"defaultAction":false,"priority":10},
  {"alias":"VERIFY_EMAIL","enabled":true,"defaultAction":false,"priority":50},
  {"alias":"delete_account","enabled":false,"defaultAction":false,"priority":60},
  {"alias":"UPDATE_PASSWORD","name":"Update Password","providerId":"UPDATE_PASSWORD","enabled":true,"defaultAction":false,"priority":61}
]
```

**Path A re-test (execute-actions-email, admin API via `gaiada-provisioner`, lifespan=900) —
throwaway `pr00b-throwaway@dev.gaiada.invalid`, both `client_id=account-console` and
`client_id=gaiada-ui`:**

1. **New-password form renders — TRUE (both clients).** The link now lands on
   `login-actions/required-action?execution=UPDATE_PASSWORD&...` with a real "Update password"
   form (New Password / Confirm password / "Sign out from other devices", pre-checked). This is
   the opposite of PR-00's finding (which went straight to "Your account has been updated" with
   zero password fields).
2. **Original password no longer works, fresh context — TRUE (decisive).** After submitting a new
   password through the `gaiada-ui` link, a fresh cookie-less context: old password
   (`OldPassw0rd!PR00b`) → login failed ("Invalid username or password"); new password → landed on
   the real authenticated Account Console. Repeated independently through the `account-console`
   link with a second new password — same result, and the *first* new password now failed too
   (correctly superseded). `kcadm get users/{id}/credentials` confirms rotation each time: the
   password credential's `createdDate` advanced on every completed submission
   (`1785995089283 → 1785995358793 → 1785995523490`), while `requiredActions` (persisted) returned
   to `[]` after each completion.
3. **No session minted on completion — TRUE (still holds, both clients).** Post-submit, the
   completion page carries only `AUTH_SESSION_ID` (Keycloak's flow cookie); navigating to
   `/idp/realms/gaiada/account/` in the *same* browser context redirects to the OIDC authorize
   endpoint (i.e., not authenticated), for both `account-console` and `gaiada-ui`.
4. **Single-use — TRUE (now, for the right reason).** Re-clicking either already-completed link in
   a fresh context produces "We are sorry... Action expired. Please continue with login now." —
   PR-00 saw FALSE here only because the flow never reached completion in the first place
   (`UpdatePassword.isOneTimeAction()` never fired); now that it does complete, single-use holds.

**Path B re-test (native `login-actions/reset-credentials`, real browser, "Forgot Password?") —
SEC-01's exact method, but with fresh throwaway users to avoid any cross-contamination with the
execute-actions runs above: `pr00b2-throwaway@dev.gaiada.invalid` (via `account-console`'s own
login page) and `pr00b3-throwaway@dev.gaiada.invalid` (via the real `gaiada-ui` ERP login →
"Sign in with SSO" → Keycloak-hosted form, so this is the actual staff-facing path, not just the
admin console):**

1. **New-password form renders — TRUE (both clients).** Identical shape to path A: clicking the
   mailed "Reset password" link (decoded `typ: "reset-credentials"`, `asid` tying it to the
   requesting session — same token type SEC-02 examined) in a brand-new cookie-less context now
   lands on `login-actions/required-action?execution=UPDATE_PASSWORD&...` with the same form. This
   directly overturns SEC-01/SEC-02's finding, which saw "Your account has been updated" with zero
   password fields and a live authenticated session on the exact same flow.
2. **Original password no longer works, fresh context — TRUE (decisive), both clients.** Account-
   console path: old password (`OldPassw0rd!PR00b2`) failed post-reset, new password
   (`NewPassw0rd!PR00b2`) succeeded, landing on the real Account Console. Gaiada-ui path
   (independent throwaway user, independent reset request under `client_id=gaiada-ui`): identical
   result — old password failed, new password succeeded. `kcadm` credentials confirm rotation
   (`createdDate` advanced) in both cases.
3. **No session minted on completion — TRUE, both clients.** This is the headline change from
   SEC-01/SEC-02: back then, completing this exact flow **did** mint a live session (landed
   directly on the authenticated account page / full ERP shell). Now, post-submit, the same-context
   navigation to `/account/` redirects to re-authenticate — no session. The form step now
   interposed between "click the link" and "flow completes" is what removes the session-minting
   side effect; it was never a separate bug, it was the *same* missing-required-action gap
   manifesting as "flow completes without ever needing the user again," which happened to also
   short-circuit into a granted session under the native flow's completion path.
4. **Single-use — TRUE, both clients.** Re-clicking the already-completed native reset link
   ("Action expired") with zero password fields on re-click — same shape as path A.

**Log evidence (the decisive artifact, not inference):** the exact warning that explained
everything in PR-00 —
`WARN [...AuthenticationManager] Could not find configuration for Required Action
UPDATE_PASSWORD, did you forget to register it?` — **does not appear anywhere** in the Keycloak
container log across this entire session (both paths, all four throwaway users, all
submit/re-click/login-check runs; checked with `docker logs --since 20m | grep -i
"UPDATE_PASSWORD\|Could not find configuration\|Required Action"` → zero matches). What *does*
appear is exactly the expected, correctly-attributed event stream: `LOGIN_ERROR
error="invalid_user_credentials"` for every old-password attempt, `EXECUTE_ACTIONS_ERROR
error="expired_code"` / `RESET_PASSWORD_ERROR error="expired_code"
reason="expiredActionMessage"` for every re-click of an already-completed link. No new/unexplained
WARN or ERROR class appeared.

**Verdict on SEC-02's #16527 diagnosis: WRONG as an explanation for the live symptom, though the
source-reading behind it was accurate on its own terms.** SEC-02 correctly read
`ResetPassword.authenticate()` queuing a session-level `UPDATE_PASSWORD` required action, and
correctly read that `AuthenticationManager.nextRequiredAction()` is the code path deciding what
happens next — but `nextRequiredAction()` never got far enough to hit the session/user-level
ordering bug #16527 describes, because **the realm had no registered provider for the alias at
all**, so Keycloak treated the queued action as unresolvable and fell straight through to
`END_AFTER_REQUIRED_ACTIONS`, before the ordering logic in question ever ran. #16527 may well be a
real, separate upstream bug in general — this session did not (and could not) exercise the
session-vs-user-level ordering path at all, since the required action now resolves cleanly on the
very first hop. The registration gap was sufficient by itself to explain 100% of both SEC-01's and
PR-00's observed symptoms (no form, no rotation, live session grant, re-clickable link) — there is
no remaining symptom that still needs #16527 to explain it.

**Recommendation: PR-01..PR-07 should be CANCELLED, not reduced.** The eight-ticket program
(SEC-03) was designed around a "no realm-config fix exists, must build a platform-owned
replacement or patch Keycloak core" premise that this ticket disproves for both paths with the
same one-line fix. Both the execute-actions-email path *and* the native forgot-password/reset-
credentials path now: render a real password form, reject the old password afterward, mint no
session on completion, and are single-use. There is no remaining gap in either path that PR-01..07
was scoped to close. If the architect wants an extra margin of defense-in-depth (e.g. still
preferring a platform-owned endpoint for anti-enumeration reasons unrelated to rotation), that is a
much smaller, optional follow-up — not the original eight-ticket core-patch/custom-SPI program,
which should be closed out as moot.

**Normal-login regression check (explicit, driven for real, not assumed):** existing dev user
`design@gaiada-creative.test` (`requiredActions: []` before and after — the new registration did
not retroactively attach itself to any existing user) signed in through the real SSO flow with
their normal password and landed on the authenticated Account Console, same as always. New
required actions on a realm only ever apply to sessions that get the action explicitly queued
(via execute-actions-email, the reset-credentials flow, or a future default-action flag we did
**not** set) — existing users with no pending required action are unaffected, confirmed live.

**Realm JSON in the repo (`infra/compose/keycloak/gaiada-realm.json`) — NOT edited this session,
flagging per the ticket's ask:** its `requiredActions` array ships only `CONFIGURE_TOTP` and
`VERIFY_EMAIL` (no `delete_account`, no `UPDATE_PASSWORD`). A fresh realm import today would carry
the exact same gap PR-00 found on the live box. Recommend adding an `UPDATE_PASSWORD` entry
(`enabled: true, defaultAction: false, priority: 61`, matching what's now live) to that array so
fresh boots don't silently regress this — not done here since the ticket scoped the *live* change
to registration only and asked to "note it," not act on it.

**Cleanup and survival, as required:** four throwaway users created across the two paths
(`pr00b-throwaway`, `pr00b2-throwaway`, `pr00b3-throwaway@dev.gaiada.invalid` — one for path A, two
independent ones for path B's two clients) all deleted and confirmed absent
(`kcadm get users -q email=... ` → `[]`) after the session. Four-project survival re-checked
post-session: `gaiada`, `gaiada-alertmanager`, `gaiada-automation` (n8n), and `gaiada-otel-metrics`
all still present with containers `Up`; `gaiada-keycloak-1` itself was never restarted (`Up 17h`
throughout — required-action registration is a live admin-API call, no restart needed). Disk
unchanged at 76%. Several `gaiada` project containers (`platform-ui`, `platform`, `mcp-hub`,
`cerbos`, `ai-gateway`, `agent-runner`, `report-renderer`) showed short uptimes
(~1-2 minutes) at the end of this session — **not caused by this ticket** (nothing here touched
compose, restarted `platform`, or redeployed anything); consistent with a concurrent session's
deploy landing on the shared box during this window (see memory `concurrent-agents-version-
drift`/`shared-repo-concurrent-sessions`). `gaiada-keycloak-1`'s own uptime is the relevant signal
for this ticket and it was untouched.

### Retirement evidence — the `emailVerified:true` provisioner workaround CAN be retired in dev

The verify-email user above is the proof: it was created with **no** `emailVerified:true` and no
special provisioner handling, and became `emailVerified:true` through nothing but the real
sink-backed verify-email mail flow. **The `gaiada-provisioner` client itself is unchanged by this
ticket** — retiring the workaround for real (non-dev) users is staging item **§15 R6**, not this
one; this only proves the *mechanism* dev needs to retire it is now live and working.

## The `google-dev` client — a local OAuth issuer for the search module (SM-51, addendum §A12.3)

The search-marketing department reaches Google Search Console / GA4 / Ads by **per-client OAuth**.
Obtaining a Google OAuth client gates **acceptance** (SM-41G), not construction — the whole
authorization-code + PKCE machine path is exercisable against this realm.

```bash
# idempotent; prints the GOOGLE_OAUTH_* values to paste into platform-nest/.env
KEYCLOAK_ADMIN_PASSWORD=<admin pw> python infra/compose/keycloak/provision-google-dev-client.py
```

It creates a **confidential** client (`google-dev`) with authorization-code flow, **PKCE S256
required**, one exactly-registered redirect URI (no wildcard — matching Google's own rule), refresh
tokens, and RFC-7009 revocation. Then set `SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT=1`: in live mode the
platform **refuses to boot** when a Google endpoint names a private/loopback host, because such a stack
would seal credential-vault rows and stamp them `linked` from an issuer that is not Google. Setting the
flag is the deliberate local opt-in; it is a lexical accident guard, not an authz control.

Users come from `provision-dev-users.py` (password `Passw0rd!`). Drive the flow end to end with
`KEYCLOAK_OAUTH_TEST=1 GOOGLE_DEV_CLIENT_SECRET=<secret> npx vitest run
src/modules/search/google/google-oauth-keycloak.test.ts` — it performs a real login form POST, a real
refresh-rotation chain, and a real client-authenticated revoke.

> **A green round trip here validates our OAuth machinery against a real issuer. It does NOT validate
> the Google integration.** Keycloak cannot rehearse Google's consent screen, incremental consent or
> scope semantics; refresh-token longevity under an app's publish status (a Testing-mode Google app's
> refresh tokens expire in **7 days**); Google-side revocation; quota/429 behaviour; or the Ads
> developer-token approval and MCC/login-customer-id semantics. Those are **SM-41G**
> (`docs/blueprints/seo-sem-execution-tracker.md` §6x.3).

Gotcha worth knowing before you edit the script: Keycloak stores `CLIENT.DESCRIPTION` as
`varchar(255)`, and a longer value fails the admin POST as an opaque **HTTP 500 `unknown_error`** —
diagnosable only from `docker logs gaiada-keycloak-1`. Same field-length class as the realm-import
comment-field fix.

## Auth-mode cutover

`AUTH_MODE=dev` (x-user-id header) is for local/tests only. Set `PLATFORM_AUTH_MODE=oidc`
on the VPS once the realm + MFA are configured; from then the platform requires a verified
IdP JWT for user access (the OBO-envelope path for the bot still works in both modes).
