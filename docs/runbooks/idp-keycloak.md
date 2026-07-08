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

## Auth-mode cutover

`AUTH_MODE=dev` (x-user-id header) is for local/tests only. Set `PLATFORM_AUTH_MODE=oidc`
on the VPS once the realm + MFA are configured; from then the platform requires a verified
IdP JWT for user access (the OBO-envelope path for the bot still works in both modes).
