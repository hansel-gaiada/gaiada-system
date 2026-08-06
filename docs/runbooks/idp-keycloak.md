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
