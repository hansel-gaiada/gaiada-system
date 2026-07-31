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
