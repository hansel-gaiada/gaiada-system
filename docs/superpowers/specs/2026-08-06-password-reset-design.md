# Self-Service Password Reset — platform-owned, Keycloak-executed (SEC-03)

> # ⛔ CANCELLED 2026-08-06 — the premise was wrong. Do not build this.
>
> **PR-00b proved a one-line realm change fixes both reset paths, so this eight-ticket program is
> unnecessary in full — cancelled, not reduced.**
>
> `UPDATE_PASSWORD` was **never registered as a required action on the `gaiada` realm** (only
> `CONFIGURE_TOTP`, `VERIFY_EMAIL`, `delete_account` were). Keycloak logged it plainly:
> `WARN Could not find configuration for Required Action UPDATE_PASSWORD, did you forget to register it?`
> After `kcadm create authentication/register-required-action -s providerId=UPDATE_PASSWORD`
> (enabled, `defaultAction: false`, priority 61), **both** paths satisfy all four conditions — form
> renders, the original password stops working, no session is minted, link is single-use — verified in
> a real browser under `account-console` and `gaiada-ui`, including the **native** reset-credentials
> flow this document was written to replace.
>
> **SEC-02's keycloak/keycloak#16527 attribution was wrong as an explanation of the live symptom.**
> The source reading was accurate on its own terms, but `nextRequiredAction()` never reached the
> session-vs-user ordering logic that issue describes — with no registered provider for the alias it
> fell through first. The registration gap accounts for 100% of both SEC-01's and PR-00's symptoms.
>
> **Why this document is kept rather than deleted:** its `execute-actions-email` mechanism analysis
> (no flow re-entry, no session minted, credential replaced) is accurate and was independently
> confirmed by PR-00b, and the reasoning about *why* a platform-minted token would be worse — it
> breaks the "platform never sees passwords" invariant, and a token-verify bug there means arbitrary
> account takeover rather than an email to the victim's own mailbox — remains the right answer if this
> ever needs revisiting.
>
> **The lesson, recorded because it cost an eight-ticket design:** three investigations, three
> methods. Driving the flow found the symptom. Reading source produced a confident, thorough, wrong
> cause. Reading the **server log** gave the answer in one line. Ask what the running system is
> *configured* with before inferring from what the code *does*.
>
> Durable fix: the registration is now in `infra/compose/keycloak/gaiada-realm.json` so a fresh
> `--import-realm` boot cannot reproduce the gap.


**Date:** 2026-08-06 · **Author:** architect · **Status:** PLANNED
**Replaces:** Keycloak's native "Forgot password?" flow on realm `gaiada`, which is broken upstream
(SEC-01 confirmed, SEC-02 root-caused: `docs/runbooks/idp-keycloak.md`).
**Companion plan:** `docs/superpowers/plans/2026-08-06-password-reset-tickets.md`.
**Owner decision honored:** the fix is platform-nest-owned self-service reset — not a Keycloak core
patch, not a custom SPI.

---

## 1. Problem (one paragraph; full detail in the runbook)

On the live realm, clicking the emailed Keycloak password-reset link grants an authenticated
session **without rotating the password**. The original password keeps working; exactly one
password credential exists afterward, at its pre-reset timestamp. Proven in a real browser under
both `account-console` and `gaiada-ui`, including in a cookie-less context. SEC-02 traced it to
Keycloak 26.0.8 core behavior (the reset-credentials action-token completion path loses the
session-scoped `UPDATE_PASSWORD` queued by `ResetPassword.authenticate()` — upstream
keycloak/keycloak#16527 territory), so **no realm-config change can fix it**. The email is today a
password-equivalent bearer login link — the exact shape decision M11 forbids.

## 2. The `execute-actions-email` hypothesis — verdict: WRONG in mechanism, RIGHT in consequence

The hypothesis to validate was: *"`execute-actions-email` with `UPDATE_PASSWORD` sets a
user-scoped required action, persisted on the `UserModel`, and therefore sidesteps the bug."*
Verified against the Keycloak **26.0.8 tag** (the exact running version), files fetched from
`github.com/keycloak/keycloak` at ref `26.0.8`:

**Wrong in mechanism — nothing is persisted on the user.**
`UserResource.executeActionsEmail` (`services/.../admin/UserResource.java`) never calls
`user.addRequiredAction(...)`. The actions ride inside the **signed `ExecuteActionsActionToken`**
(`new ExecuteActionsActionToken(user.getId(), user.getEmail(), expiration, actions, redirectUri,
clientId)`). Consequences the design must not mis-state:

- `kcadm get users/<id> --fields requiredActions` will read `[]` before, during, and after — same
  as today. That field is NOT the health signal for this flow, and no test may use it as one.
- Requesting a reset blocks nothing and invalidates nothing: normal login with the current
  password is untouched until the form is completed (correct — an unauthenticated endpoint must
  not be able to lock accounts, i.e. no request-time DoS).

**Right in consequence — the bug is sidestepped, for a different reason than the hypothesis
gives.** The broken path and the execute-actions path are **disjoint code paths**:

| | Native reset-credentials (broken) | `execute-actions-email` (proposed) |
|---|---|---|
| Handler (26.0.8) | `ResetCredentialsActionTokenHandler.handleToken` | `ExecuteActionsActionTokenHandler.handleToken` |
| What it runs | `tokenContext.processFlow(...)` — re-executes the whole `reset credentials` **authentication flow**, completing via `ResetCredsAuthenticationProcessor.authenticationComplete()` | **No flow at all.** Applies token actions to the auth session (`token.getRequiredActions().forEach(authSession::addRequiredAction)`, line 109) and **in the same request** calls `AuthenticationManager.nextRequiredAction(...)` → `redirectToRequiredActions(...)` (lines 115–116) |
| Where the action is queued | By `ResetPassword.authenticate()` onto the auth session **mid-flow**, then must survive the flow-completion path — which is where it is lost (#16527, still open upstream) | In the same request that resolves it; `AuthenticationManager.nextRequiredAction` → `getFirstApplicableRequiredAction` demonstrably merges `user.getRequiredActionsStream()` **and** `authSession.getRequiredActions()` (verified in 26.0.8 `AuthenticationManager.java`) |
| End state | Completes to an authenticated session / "account updated" **without the form** (observed live, SEC-01/SEC-02) | The `UPDATE_PASSWORD` challenge form is the next response; completion renders the `END_AFTER_REQUIRED_ACTIONS` info page — **no session is minted** |

Further 26.0.8 facts the design leans on, all read from source:

1. **The credential is replaced, not appended.** The `UPDATE_PASSWORD` required action calls
   `user.credentialManager().updateCredential(UserCredentialModel.password(passwordNew, false))`
   (`UpdatePassword.java:189`) — this **rotates the single password credential**, so the old
   password stops working the moment the form is submitted. Realm password policy is enforced
   there (policy violation → re-challenge with the error, `ModelException` catch).
2. **Single-use.** `ExecuteActionsActionTokenHandler.canUseTokenRepeatedly` returns false when any
   carried action's factory `isOneTimeAction()` — and `UpdatePassword.isOneTimeAction()` is `true`
   (`UpdatePassword.java:245-247`). The link is re-clickable until the action completes or the
   token expires (abandoned-form UX), and dead after completion (single-use store).
3. **Scanner-prefetch protection is built in.** Every real-world click arrives with no matching
   auth session (`isAuthenticationSessionFresh()`), so Keycloak first renders a **confirmation
   interstitial** ("Perform the following action(s): Update Password") whose confirm link
   re-binds the token to the fresh session (handler lines 83–98). A mail-scanner GET burns
   nothing. Tests must expect TWO pages: interstitial → password form.
4. **`lifespan` is per-call.** Default is `actionTokenGeneratedByAdminLifespan` (realm default
   12 h). We pass **`lifespan=900`** (15 min) to match the magic-link bar — omitting it would ship
   a 12-hour mailbox credential and flunk our own token table.
5. **Side effect:** redemption sets `user.setEmailVerified(true)` (handler line 113) — legitimate
   (the click proves mailbox control) and consistent with the platform's takeover guard (§10).
6. **Permission:** `auth.users().requireManage(user)` — the existing `gaiada-provisioner`
   service-account client (realm-management `manage-users` + `view-users`, measured 2026-08-03,
   escalation probe 403) suffices. It is already wrapped by
   `platform-nest/src/core/keycloak-admin.ts` (W0-3), which this design extends by **one function**.

**What this implies for the "old password must stop working" guarantee, exactly:**
- At **request** time: nothing changes and nothing must (DoS resistance).
- At **completion** time: the guarantee is enforced by Keycloak's credential manager replacing the
  one password credential — not by anything we build. Our flow's job is to make sure the ONLY way
  the emailed link can terminate is *through* that form (which the execute-actions path
  structurally does — there is no flow-completion path to fall through), and that the link mints
  **no session** either way (`END_AFTER_REQUIRED_ACTIONS` → info page; verified in
  `AuthenticationManager.finishedRequiredActions`).
- Residual truth of any email-based reset: whoever controls the mailbox can set a new password.
  That is the industry-standard trust root and is unchanged. What is FIXED: today's link grants a
  **silent** session with **no rotation** (victim never learns); the new link cannot grant a
  session at all, and any use of it rotates the credential — loudly, with an optional
  "sign out other devices" checkbox on the form (`UpdatePassword.java:184-186`).

**Discipline note (the SEC-01 trap):** source reading is necessary but NOT sufficient — the same
realm read "correctly configured" for weeks. Ticket **PR-00** drives this exact behavior in a real
browser on the live realm **before** anything is built on it. If PR-00 falsifies the above, this
design is void and the three fix paths re-open (§4).

## 3. Decision — who mints the token

**DECIDED: Keycloak mints (via `execute-actions-email`); platform-nest owns the request surface.**
The platform endpoint carries the anti-enumeration, rate-limiting, audit, and metrics duties
(reusing the MAIL-10/24/26 substrate verbatim in structure); Keycloak carries the token, the form,
the policy, and the credential write.

Rejected alternative — **platform-minted token + platform-hosted new-password form + admin
`reset-password` call** ("Option B"):

| Axis | A (chosen): KC mints/executes | B: platform mints + sets password |
|---|---|---|
| Old-password guarantee | KC replaces credential at form submit | Same guarantee, enforced by our call |
| "Platform never sees passwords" (P5b invariant, runbook line 3) | **Preserved** — the new password goes browser→Keycloak | **Broken** — new password transits platform-nest |
| Blast radius of a bug in OUR code | Worst case: a reset mail is sent to the victim's **own verified mailbox**; no privilege moves | Worst case: token-verify bug ⇒ attacker **sets any user's password** (full takeover) |
| New DDL | **None** (KC token is signed + single-use store) | New token table + migration |
| Password policy, localization, logout-other-sessions, form a11y | Keycloak's, already built | Re-owned by us, forever |
| Mail composition/delivery observability | Keycloak's SMTP + templates (gap; §8) | Fully ours |
| Works even if KC's execute-actions path were also broken | No | Yes |

The one real advantage of B (delivery observability + our template branding) does not outweigh the
invariant break and the takeover-class blast radius. B remains the documented **fallback if PR-00
fails**.

## 4. Rejected structural paths (kept for the record)

- **Patch Keycloak core (`AuthenticationManager`)** — blast radius is every required-action
  resolution on the realm; requires forking + building + signing a custom Keycloak image (no Java
  pipeline exists in this repo; WS10's supply chain would gain a permanent fork); upgrade drag on
  every KC bump. Rejected.
- **Custom SPI authenticator replacing `reset-password`** (the #16527 author's own endpoint) —
  narrower, but still a Java provider built into and mounted in the image; same pipeline/upgrade
  costs; and it keeps "forgot password" ownership in Keycloak where we just proved we cannot see
  breakage from config. Rejected.
- Both re-open only if PR-00 falsifies §2.

## 5. Architecture

```
Browser ── GET /auth/reset-password ──────────► platform-ui (public page; /auth/* is already
   │                                            middleware-public — src/middleware.ts:21)
   │  email
   ▼
platform-ui BFF route ── POST /auth/password-reset (Bearer PLATFORM_SERVICE_TOKEN,
   │                     x-forwarded-for = browser IP) ──► platform-nest
   │                                                          │ always 202 {ok:true}
   │◄─── generic "if that address exists, mail is on its way" ┘ (or 503 suppressed / 404 flag off)
   │
   │        (after the response, fire-and-forget:)
   │        platform-nest ── PUT /admin/realms/gaiada/users/{id}/execute-actions-email
   │                          ?lifespan=900&client_id=gaiada-ui&redirect_uri=<per §9>
   │                          body ["UPDATE_PASSWORD"]  (keycloak-admin.ts, provisioner client)
   ▼
Keycloak ── composes + sends the mail (realm smtpServer → Mailpit dev / auth-relay staging)
   │
User clicks link ──► KC confirmation interstitial ──► KC UPDATE_PASSWORD form
   ──► credential REPLACED (+ optional "sign out other devices") ──► "Your account has been
   updated" info page + "Back to application" link. NO session minted by the link.
```

### 5.1 Platform endpoint — `POST /auth/password-reset`

Root-level (no `/api` prefix), `ServiceGuard`-gated, BFF-internal — the exact shape of
`POST /auth/magic-link` (`src/mail/magic-link/controller.ts`). New module
`src/mail/password-reset/` (controller, service, rate-limit), **sibling of, not shared state
with**, `src/mail/magic-link/` — the same deliberate no-generalizing separation the magic-link
limiter documents against the inbound limiter.

Request handling, mirroring `requestMagicLink` branch-for-branch:

1. `MAIL_PASSWORD_RESET_ENABLED` off → 404 (`PasswordResetNotEnabledError`, magic-link parity).
2. `normalizeEmail`; `clientIp()` with the **same** trusted-proxy allowlist
   (`config.mail.magicLinkTrustedProxies` — shared infra topology, deliberately one var; the
   slightly-misnamed var is noted, rename deferred).
3. Rate limits: **own module-level Map** (`src/mail/password-reset/rate-limit.ts`, cloned shape),
   own env `MAIL_PASSWORD_RESET_RATE_PER_ADDRESS_HOUR=3` / `..._PER_IP_HOUR=10`. Separate buckets
   from magic links on purpose: a reset probe must not burn a victim's login-link budget; combined
   worst case to one victim address is 6 mails/hr. Exceeded → `recordPasswordResetRateLimited(dim)`
   → decoy work → 202.
4. Local lookup (never a KC call pre-response):
   `SELECT id, idp_subject FROM users WHERE email=$1 AND status='active' AND deleted_at IS NULL`
   plus a **human-kind exclusion**: automation/bot/service principals are deliberately `users`
   rows (principal-kinds decision), and no reset mail may ever be dispatched for one. Implementer
   binds the predicate to the current mechanism (`company_memberships.kind='service'` exclusion
   today; `users.kind` when it lands) — AC-pinned, not name-pinned here.
5. Unknown / excluded → **decoy equivalent work** → 202. The decoy MIRRORS THIS FLOW's real
   branch (suppression SELECT + `mail_log` INSERT+DELETE inside a rolled-back transaction), NOT
   magic-link's four-step decoy — the real branches differ (no `auth_magic_links` INSERT, no
   template render here), and an inherited-but-wrong decoy is exactly how a fresh timing oracle
   ships. Bar: `mail24-timing-remeasure.test.ts` methodology (N=30/branch, medians over a real
   DB), **ratio < 1.8 test-pinned** (magic-link measured 1.28x post-fix; pre-fix was 3.25x).
6. Known + suppressed (`isSuppressed(c, email, 'auth')`) → `{status:"suppressed"}` → controller
   503 "delivery unavailable — contact an admin". This mirrors design §5.1's ONE documented
   deliberate deviation from indistinguishability, kept identical across both auth flows so there
   is exactly one exception to reason about, not two.
7. Known → write `mail_log` audit row, THEN respond 202, with the Keycloak interaction
   **fire-and-forget after the response** (§5.2). The KC admin round trips (possible
   `findUserByEmail` + the execute-actions PUT + possible token mint) are 10s–100s of ms and exist
   only on the known branch — awaiting them in-handler would be a gross timing oracle no decoy
   could hide.

Response contract (byte-identical bodies for known/unknown/rate-limited): `202 {"ok":true}`.
No CAPTCHA (rate limits + always-202 are the abuse posture, magic-link parity).

### 5.2 Dispatch task (post-response, single-attempt)

1. Resolve the KC user id: `users.idp_subject` when set (it is the KC subject; unique-indexed
   since `0003_idp_subject.sql`), else `findUserByEmail(email)` (keycloak-admin.ts, exact-match).
   Unresolvable (dev-login-only user with no KC counterpart) → mark the row failed, metric, stop.
2. `sendExecuteActionsEmail(kcUserId, ["UPDATE_PASSWORD"], { lifespan: 900, clientId:
   "gaiada-ui", redirectUri })` — the ONE new function in `keycloak-admin.ts`, riding its existing
   token cache, 401-retry-once, and error family. KC 204 = accepted.
3. `mail_log` row transitions, magic-link convention: inserted as `status='sending'`
   (stream `'auth'`, `template_key='auth.password_reset'`, `to_email`, `user_id`,
   `entity_type='auth_password_reset'`, `entity_id=<kc user id>`, redacted
   `payload={"ttlMinutes":15}` — no token exists on our side to leak, kept redacted anyway) →
   `'sent'` with `provider='keycloak'`, `provider_message_id=NULL`, `provider_accepted_at=now()`
   on 204 → `'failed'` + `last_error` otherwise. **Row semantics: this records the DISPATCH
   DECISION and KC's acceptance of it, not SMTP delivery** — delivery is Keycloak's (§8).
4. Metrics: `recordEnqueued("auth","auth.password_reset")` at insert; `recordSent("auth")` /
   `recordFailed("auth")` on the transition. `recordFailed("auth")` deliberately reuses the
   auth-stream counter so the existing **`MailAuthStreamSendFailed`** page-on-any-increase alert
   covers reset dispatch failures with zero new plumbing (its summary text gains
   "/ password-reset" wording). Single-attempt, no retry — same reasoning as magic-link's
   header: the loud alert IS the compensating control; the user-side recovery is "request again."

### 5.3 What is shared code vs duplicated vs new (explicit, per the brief)

| Piece | Reuse mode |
|---|---|
| `ServiceGuard`, `clientIp()`/trusted-proxy gate, `normalizeEmail`, `isSuppressed`, `mail_log` + its conventions, `recordEnqueued/Sent/Failed`, `MailAuthStreamSendFailed` alert, `withGlobal`/`withMailContext` | **Shared as-is** (imports; zero forks) |
| `checkHourlyRate` fixed-window limiter, decoy-work pattern, controller shape, flag-gate 404, audit console-line pattern | **Cloned into `src/mail/password-reset/`** with its own Map/keys — deliberate state separation, same policy values |
| `auth_magic_links` table, `tokens.ts` (mint/hash), consume endpoint, `auth.magic_link` template | **NOT used. Nothing to mint or consume on our side.** A pin test asserts the reset path never touches `auth_magic_links` nor renders `auth.magic_link` (and vice versa) |
| `sendExecuteActionsEmail` in `keycloak-admin.ts`; `/auth/reset-password` UI page; `mail_password_reset_rate_limited_total` + its alert; KC login theme | **New** |

### 5.4 Distinguishability in `mail_log`, metrics, audit (per the brief)

- `mail_log.template_key`: `'auth.magic_link'` vs `'auth.password_reset'` (free-text column,
  landed by `0077_mail_core.sql` — **no DDL to extend**); reset rows additionally read
  `provider='keycloak'`, `entity_type='auth_password_reset'`.
- Metrics: `mail_enqueued_total{stream="auth",template="auth.password_reset"}`; new counter
  `mail_password_reset_rate_limited_total{dimension="address"|"ip"}` + alert
  `MailPasswordResetRateLimitSustained` (`increase(...[15m]) > 10`, clone of
  `MailMagicLinkRateLimitSustained` in `infra/observability/prometheus/rules/alerts.yml`).
- Audit lines: `[password-reset:audit]` prefix (vs `[magic-link:audit]`), token-free by
  construction (there is no token), events `request.rate_limited | request.unknown_address |
  request.excluded_kind | request.suppressed | dispatch.ok | dispatch.failed`.

## 6. Token semantics — the four mailed-link kinds (M11 discipline)

M11 stands: a magic link is never an approval mechanism. A reset link is a **third thing again**
(fourth counting invites). Precise capability statement:

| Link | Minted by | Grants on redemption | Single-use | TTL | Stored at rest |
|---|---|---|---|---|---|
| Magic login link (§9 mail design) | platform (`auth_magic_links`) | a login session (`sealSession`) | atomic `UPDATE…RETURNING` | 15 min | hash only |
| Invite link (W0-5) | platform (`client_invites`) | account provisioning + first login for the invited contact | single-use, HMAC-signed, email-bound | bounded | server-verified |
| Approval deep link (§7.5) | nobody — plain URL | **nothing** — auth at the door | n/a | n/a | n/a |
| **Password-reset link (this design)** | **Keycloak** (`ExecuteActionsActionToken`, typ `execute-actions`) | **only** entry to the `UPDATE_PASSWORD` challenge; **cannot mint a session** (completion = `END_AFTER_REQUIRED_ACTIONS` info page); marks email verified | single-use **on completion** (`isOneTimeAction`); re-clickable if abandoned, until TTL | 15 min (`lifespan=900`, explicit — realm default is 12 h) | nothing in our DB; KC signed token + single-use store |
| (removed) native reset-credentials link | Keycloak | **an authenticated session, silently, without rotation — the vulnerability** | — | realm default | — |

The reset link may never be used as a login OR approval mechanism; any future "streamline login
via the reset mail" proposal re-opens M11 with the owner, verbatim per §9 of the mail design.

## 7. Closing Keycloak's native "Forgot password?" — mandatory, verified in-browser

Fixing our flow while the login page still offers the broken one leaves the vulnerability live.
One realm boolean kills **all three** native surfaces — verified in 26.0.8 source:

1. The login-page link: the theme renders it conditionally on `realm.resetPasswordAllowed`.
2. The direct endpoint: `LoginActionsService.resetCredentials` error-pages
   (`RESET_CREDENTIAL_NOT_ALLOWED`, HTTP 400 page) when disabled — both the no-session deep-link
   path (`LoginActionsService.java:451`) and the in-flow path (`:524`). Bookmarked URLs die.
3. **Already-issued emailed reset tokens:** `ResetCredentialsActionTokenHandler.getVerifiers`
   includes `checkThat(realm::isResetPasswordAllowed, …)` (line 55) — outstanding links are
   rejected at redemption, not grandfathered.

Mechanics (both halves, one ticket — the import-skips-existing-realm trap is documented in the
runbook): live `kcadm.sh update realms/gaiada -s resetPasswordAllowed=false` AND flip
`infra/compose/keycloak/gaiada-realm.json` (`"resetPasswordAllowed": true`, currently line 13) so
fresh boots match. Rollback = flip both back.

**Not affected (assert, don't assume):** authenticated self-service password change
(account console / `kc_action` AIA) and admin-console **Credential Reset** (which is
execute-actions-email — the helpdesk fallback) keep working. PR-01's ACs drive all of this in a
real browser, including redeeming a pre-flip-minted native reset token and watching it get
rejected.

**Discoverability replacement:** users still need a way in from the KC login page (with SSO
auto-redirect, it is the only pre-auth surface they ever see). A minimal custom **login theme**
`gaiada` (first custom theme in the estate; realm currently has no `loginTheme` set) overrides the
login template to render "Forgot password? → `${MAIL_LINK_BASE_URL}/auth/reset-password`"
unconditionally. Theme = static FTL + properties under `infra/compose/keycloak/themes/gaiada/`,
bind-mounted, `loginTheme` set live + in the realm JSON. Known traps, pre-declared: parent theme
must match the running default (confirm on the box); theme caching means edits need
`--spi-theme-cache-themes=false` or a restart (the Cerbos-policy-reload trap's cousin); the FTL
fork is a per-KC-upgrade re-check item. **Sequencing:** the realm flip may precede the theme+page
(owner call, §12 Q1) — interim resets go through the admin-console helpdesk path, which PR-00
proves working. The interim gap trades a *broken, vulnerable* self-service for *no* self-service;
nobody loses a working feature.

## 8. Observability seams — stated, not hidden

- Our `mail_log` `'sent'` means **Keycloak accepted the dispatch**, not that SMTP delivery
  happened. KC's own send failures land in KC's server log only (dev: the mail is in Mailpit or
  it isn't). Accepted for dev; staging re-verification is R6's relay leg (§11).
- **No delivery-latency SLO is measurable for reset mail from `mail_log`** (delivered−queued
  needs both timestamps on our side; delivery is KC's). §15 R5's SLO stays scoped to magic links.
  If reset-mail latency ever needs an SLO, that is a KC-event-scraping feature (WS9 territory),
  deliberately out of scope here.
- Consume-side signals (link clicked, form abandoned, completion) live in KC's event log
  (`RESET_PASSWORD`/`EXECUTE_ACTIONS`/`UPDATE_PASSWORD` event types), not our metrics. The QA
  E2E reads them via `kcadm`; continuous scraping is deferred with the same WS9 note.

## 9. Client-portal vs staff scope

Both populations are Keycloak users in realm `gaiada` and both SSO through the same login page →
**one flow, one endpoint, one UI page serves both**. The split follows §7.5's staff-vs-portal href
precedent, applied server-side at dispatch (never from requester input): the platform resolves the
user's kind from its own DB — client-only contacts (the `isClientOnly` predicate family, W0-5)
get `redirect_uri=${MAIL_LINK_BASE_URL}/portal`; everyone else `${MAIL_LINK_BASE_URL}/`. The
`redirect_uri` only decorates the post-completion "Back to application" link (KC validates it
against `gaiada-ui`'s registered redirect URIs; PR-00 verifies acceptance, and if the registered
patterns don't cover these two exact URIs, the ticket adds them to the client — realm JSON + live
— rather than shipping without). Failure mode if omitted/invalid: the flow still completes with a
plain info page; UX garnish only, never correctness.

## 10. Existing dev users, `emailVerified:true`, and §15 R6

- Dev users (`provision-dev-users.py`, `Passw0rd!`) are unaffected; they can exercise the new
  flow against Mailpit like any user.
- The execute-actions redemption side effect (`setEmailVerified(true)`) is consistent with the
  OIDC takeover guard (link-by-email requires IdP-verified email) — it can only ever flip a user
  who just proved mailbox control, i.e. a *second* legitimate verification mechanism next to the
  verify-email flow MAIL-03 proved.
- **R6's retirement path is UNCHANGED by this design.** `gaiada-provisioner` keeps stamping
  `emailVerified:true` at create (load-bearing per `keycloak-admin.ts`'s header — invited
  contacts' first login THROWS without it); retiring it for real users remains the staging-gated
  owner decision R6 already records, taken only after real-relay deliverability is proven. This
  design adds one item to R6's re-verification: the reset E2E re-runs against the real relay
  (§11).

## 11. Verification bar

**The pass condition, as a test (QA ticket PR-06; browser-driven, config inspection is
insufficient by SEC-01/SEC-02 precedent):**

1. From `/auth/reset-password` (staff surface): submit a throwaway user's email → generic
   confirmation; Mailpit shows the KC-sent mail within seconds.
2. Open the link in a **fresh, cookie-less browser context** → KC confirmation interstitial →
   confirm → **a form with `input[type=password]` fields renders** (new + confirm, plus the
   sign-out-other-devices checkbox).
3. Submit a policy-valid new password → "Your account has been updated" info page with a
   "Back to application" link. Assert **no authenticated app session exists** in that context
   (navigating to the ERP demands login).
4. Fresh context: the **original password FAILS** under BOTH `account-console` and `gaiada-ui`;
   the new password succeeds under both. `kcadm`: exactly one password credential,
   `createdDate` advanced. Re-clicking the link → invalid/expired error page (single-use).
5. Client-kind user variant: same flow; Back-to-application targets `/portal`.
6. Native flow closed (re-assert post-everything): no forgot-password link except ours; direct
   `login-actions/reset-credentials` GET and POST → error page; a pre-flip native reset token is
   rejected; account-console self-service change and admin Credential Reset still work.
7. Enumeration: N=30/branch known-vs-unknown timing against the deployed endpoint, median ratio
   **< 1.8** (the test-pinned magic-link bar; measured 1.28x there), and byte-identical 202
   bodies. Rate-limit and suppressed-503 behavior asserted.

**Execution reality:** the Keycloak-side tickets (PR-00 spike, PR-01 realm flip, PR-05 theme) are
box-direct on gda-aicenter and unblocked today (SEC-01/02 drove the identical harness). The
platform-nest + platform-ui halves ride the deploy pipeline; while GitHub Actions is
billing-blocked (Q-O4) they are **code-complete-but-unverifiable on the live box** and must be
reported IN PROGRESS with the live leg PENDING-DEPLOY, never DEV-VERIFIED on local suites alone
(§13 v4 billing-wall rule, binding).

**UNVERIFIED until the staging reopen, regardless of dev evidence:**
- Real-relay delivery of KC-sent reset mail (TLS/auth from Keycloak to the relay) — rides §15
  **R6**, whose re-verification step gains "re-run the PR-06 reset E2E to a real inbox".
- Deliverability/inbox placement and the DNS identity underneath it (R1/R2, inherited).
- §15 **R5** (the p95/p99 auth-stream SLO over ≥7 days of real traffic) — R5 gates MAGIC-LINK
  enablement and is not extended to reset (§8: no reset-delivery SLO is measurable from our side);
  the staging-infra enumeration-timing **re-probe** in R5 SHOULD be run against both auth
  endpoints in the same session.
- Production enablement of `MAIL_PASSWORD_RESET_ENABLED` for real users + the real-user
  helpdesk-fallback runbook path — proposed register row **R10** (text in the ticket plan §5;
  applied by the orchestrator, since this session must not edit the mail design doc).

## 12. Migrations, config, registration

- **Zero new DDL.** No table (KC token is stateless-signed + single-use store), no `mail_log`
  change (`template_key` is free text), rate limiter is in-memory by explicit magic-link-parity
  design. **Contingency discipline if any implementer discovers DDL is needed after all:** the
  number is "next unused at build time" — re-verify with
  `ls platform-nest/migrations | sort | tail` immediately before writing (the ledger moved five
  times in one session: 0077→0084; next-unused reads 0085 as of 2026-08-06 and MUST be re-checked,
  not trusted); never fill `0058`, `0059`, or `0070`.
- **New env (each var wired through the `platform` service `environment:` block in the SAME
  ticket, AC greps `docker-compose.vps.yml` — the binding per-ticket passthrough rule):**
  `MAIL_PASSWORD_RESET_ENABLED` (default 0), `MAIL_PASSWORD_RESET_RATE_PER_ADDRESS_HOUR` (3),
  `MAIL_PASSWORD_RESET_RATE_PER_IP_HOUR` (10). Reused as-is: `KEYCLOAK_ADMIN_*` (4 vars, already
  live for W0-3), `MAIL_LINK_BASE_URL`, `MAIL_MAGIC_LINK_TRUSTED_PROXIES`, `PLATFORM_SERVICE_TOKEN`.
- **Registration:** MODULES.md/CHANGELOG.md text is delivered in the architect's report (those
  files must not be edited from this session — two concurrent-append losses already). Not a
  BLUEPRINTS.md item (that index is for the rendered C-level blueprints).

## 13. Open questions for the owner (genuinely blocking)

1. **Interim closure timing:** flip `resetPasswordAllowed=false` immediately after PR-00 (kills
   the live vulnerability now; resets go through admin-console helpdesk until the platform flow
   deploys) — or keep the broken-but-discoverable native flow until the replacement ships in one
   move? **Recommendation: immediate.** The native flow's only current function is the
   vulnerability; there is no working self-service to lose.
2. **Billing wall (Q-O4):** the platform/UI halves cannot reach the live box until GitHub Actions
   billing clears. If it remains blocked when PR-03/04 are code-complete, may QA run the full
   browser E2E against the local compose stack as an explicit, recorded exception to
   "server is truth" (result capped at DEV-VERIFIED-local), or do those tickets wait?
