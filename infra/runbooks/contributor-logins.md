# Runbook — contributor logins in realm `gaiada` (M5-W1g)

Status: PLANNED. Nothing below has been applied to the live realm. The audit in §1 is a read-only measurement.

Freelance writers sign in as `users.kind = 'contributor'` principals (M5-W1d, WSK-D84). The ERP holds them behind three
walls:

1. the `AuthGuard` route fence, where only `@ContributorRoute()` handlers are open, and only at a real `high` assurance;
2. Cerbos contributor DENYs;
3. WebDesk's `CONTRIBUTOR_COMMANDS` allow-list (M5-W1e).

What the realm itself must provide: the `contributors` group that accept adds the account to, and an `amr` claim, so that a
contributor's OTP login can reach `high` at all. Until both exist, a real contributor's session is refused by wall 1, which
fails closed: `contributor_route_forbidden`, reason `assurance_high_required`.

## 1. Audit of the realm's clients (read-only, 2026-10-27, Keycloak 26.0.8 on gda-aicenter)

Measured with `kcadm get clients -r gaiada` after one sign-in with the container's own `KC_BOOTSTRAP_ADMIN_*` env (the
password never left the container). No client has an `authenticationFlowBindingOverrides` entry, and no client restricts
sign-in by group.

| Client | Can sign a person in | Effect for a contributor |
|---|---|---|
| `gaiada-ui` (public), `gaiada-platform` (confidential) | yes (standard flow) | The ERP. Tokens carry `aud=gaiada-platform` via the `gaiada-platform-audience` mapper; the platform accepts only that audience (`OIDC_AUDIENCE`). The ERP's fence then applies. |
| `account`, `account-console` | yes | Keycloak's self-service account page. A contributor may manage their own password and OTP there, which is intended. |
| `security-admin-console`, `realm-management` | yes (login page) | The admin console. A contributor holds no `realm-management` role, so they can do nothing there. |
| `admin-cli` | direct password grant **enabled** (Keycloak's default) | A password-only token is issued to `admin-cli` without `aud=gaiada-platform`, so the platform refuses it. **Hardening option for the owner:** turn off direct access grants on this realm's `admin-cli` (`kcadm update clients/<id> -r gaiada -s directAccessGrantsEnabled=false`). The master realm's `admin-cli`, which kcadm uses, is a different client and is unaffected. |
| `broker` | yes (identity brokering) | No identity provider is configured, so it is unused. |
| `gaiada-provisioner`, `webdesk-control` | no (service accounts only) | Not sign-in clients. |

Groups in the realm today: **none**.

## 2. What to apply, in order (owner approval required; a live realm change)

0. **Rollback point:** `kcadm get realms/gaiada > realm-gaiada-$(date -u +%Y%m%dT%H%M%SZ).json`, and
   `kcadm get clients -r gaiada > clients-gaiada-….json`, both on the box. Neither holds a secret.
1. **The group.** `kcadm create groups -r gaiada -s name=contributors`. It is additive: nobody is in it, and no flow reads
   it. Accept (`POST /api/editorial-invites/accept`) adds the new account to it and sets `CONFIGURE_TOTP` as a required action.
   Revert: `kcadm delete groups/<id> -r gaiada`.
2. **The `amr` claim.** Follow `infra/runbooks/enable-mfa.md` §3.1 onward (the `oidc-amr-mapper` on `gaiada-ui`, mirrored to
   `gaiada-platform`, then the reference value `otp` on the OTP execution). That runbook is also the staff real-MFA cut-over
   (PGL-04 step 1, after staging, PV-D45). Its §3 order keeps `hansel@gaiada.com` from being locked out. The mapper alone
   changes nothing observable (`amr: []` until a reference value exists).
3. **The proof.** On mock data, with a labelled test contributor:
   1. invite the contributor (`POST /api/:t/modules/webdev/editorial/contributors/invite`), then accept;
   2. set up OTP at first login, then sign in;
   3. expect `/api/me` to show `kind: "contributor"` and assurance `high` (not simulated);
   4. expect an open route to answer 200 and any other route to answer 403 `contributor_route_forbidden`;
   5. end the contributor (`…/:userId/end`) and expect the login to be disabled.

   Record it in the M5 plan's W1 row.

## 3. When

Step 1 is safe at any time. Step 2 is the staff real-MFA step, scheduled after staging (PV-D45), and contributors need it
too. Real freelance writers should not sign in before then anyway, because the ERP holds mock data until the cut-over.
