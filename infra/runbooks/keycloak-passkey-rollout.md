# Runbook — Passkey sign-in on live (PID-2g, PID-5)

**Tickets:** PID-2g (this runbook), PID-5b to 5d. Plan: `docs/plans/2026-10-30-phone-identity.md` (§5 the design, §6 the
risks, §7 the order).

**Status: PLANNED.**
- The tools are DEV-VERIFIED on sumopod, with `infra/scripts/keycloak-passkey-realm-test.sh all`:
  - the realm script `infra/scripts/keycloak-passkey-realm.sh` (PID-2);
  - the gaiada-keycloak image `keycloak/` (PID-2h).
- **Already on live:** Keycloak 26.8.1 (release 474) and brute-force detection (`STEPS=bruteforce`, 2026-10-30).
- **Nothing else yet.** No passkey flow, no phone attribute, no theme, and the stock image.

## Rules for every step (plan §6 risk 1)

1. **Break-glass first.** `bash keycloak-passkey-realm.sh status` signs in with the Keycloak bootstrap admin of the
   master realm, inside the container, with no password on the host. That admin never goes through the gaiada realm's
   flows. If `status` fails, stop.
2. Run a **dry run**, then the apply. The apply prints `BACKUP <dir>` first. Write that directory down: it is the revert.
3. **One change, then a test sign-in.** Never retry a failed sign-in on a real account: brute-force detection is on.
4. **The revert** is `bash keycloak-passkey-realm.sh revert <dir>`, from the same box. It restores the realm settings,
   the client bindings and theme, the profile, the labels and the required actions, and deletes the flows. Passkeys
   people enrolled stay on their accounts, which is harmless.

All commands run on gda-aicenter, in `~/gaiada/infra/scripts` (the deploy's copy of the repo). The container is
`gaiada-keycloak-1`.

## Step A — the gaiada-keycloak image (PID-2h)

Live runs the stock `quay.io/keycloak/keycloak:26.8.1`. The phone sign-in form and the gaiada theme need our image.
- **The image:** `.github/workflows/keycloak-image.yml` builds and signs it when `keycloak/` lands on main. The tag is
  in that run's summary: `gaiada-keycloak:26.8.1-<tree>`.
- **The live change** is one compose line in `infra/compose/docker-compose.vps.yml`:
  `image: ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-keycloak:26.8.1-<tree>`.
  - `deploy.yml` already verifies that image's cosign signature (identity `keycloak-image.yml`) as soon as compose
    names it.
  - The server's image prune leaves `gaiada-keycloak` alone: its tag is not a release tag.

1. **Window and train.** The change restarts Keycloak once, with sign-in down for about a minute. It is the same
   version and the same database, with no migration. It rides a train **alone**, in the owner's window (plan §6 risk 15).
2. **No dump is needed** (no schema change). Take one anyway if a dump older than 24 hours is all there is: upgrade
   runbook §1.
3. **Checks after the deploy:** the checks in `keycloak-upgrade.md` §3 (issuer, owner sign-in, the provisioner,
   IT → Sign-ins). Then:

   ```bash
   bash keycloak-passkey-realm.sh status | tail -3   # "PID-2h on this server: form true, theme true"
   ```

4. **Revert:** put the compose line back to `quay.io/keycloak/keycloak:26.8.1` and `up -d keycloak`.
   - ⚠ **Only while the realm does not use the form or the theme** (before step B, or after B's revert).
   - A flow that names `gaiada-phone-username-password-form` on a server without it cannot sign anyone in.
   - So the order is always: **realm revert first, then the image.**

## Step B — on a test client only (PID-5b)

Everyone else keeps today's sign-in. With `PHONE_REQUIRED=0`:
- nobody is asked for a phone number;
- the username is not editable;
- `VERIFY_PROFILE` is untouched.

The amr mapper goes on the test client only.

1. **The test client**, once. It is public, and the code is never exchanged. It lands on the account console, which
   then signs in by itself from the same session.

   ```bash
   docker exec gaiada-keycloak-1 sh -c 'K=/opt/keycloak/bin/kcadm.sh; C=/tmp/pidb.cfg
     $K config credentials --config $C --server http://localhost:8080/idp --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null &&
     $K create clients -r gaiada --config $C -b "{\"clientId\":\"pid-passkey-test\",\"publicClient\":true,\"standardFlowEnabled\":true,\"directAccessGrantsEnabled\":false,\"redirectUris\":[\"https://erp.gaiada.com/idp/realms/gaiada/account/*\"],\"webOrigins\":[\"+\"]}"; rm -f $C'
   ```

2. **Apply** (dry run first: the same line with `--dry-run`):

   ```bash
   RP_ID=erp.gaiada.com BIND=client:pid-passkey-test PHONE_REQUIRED=0 AMR_CLIENTS=pid-passkey-test \
     STEPS="profile webauthn theme browser amr" bash keycloak-passkey-realm.sh apply
   ```

   - `RP_ID=erp.gaiada.com` is permanent: a passkey works only for its RP ID. `api.erp.gaiada.com` is covered.
   - The realm's own sign-in, theme and reset stay as they are (proved: "only pid-test changed").

3. **The owner's number:** in the account console (https://erp.gaiada.com/idp/realms/gaiada/account → Personal info →
   Phone number, `+62…`).
4. **The owner enrols, on a computer.** Open this link:

   ```
   https://erp.gaiada.com/idp/realms/gaiada/protocol/openid-connect/auth?client_id=pid-passkey-test&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Ferp.gaiada.com%2Fidp%2Frealms%2Fgaiada%2Faccount%2F
   ```

   1. Type the phone number (08… is fine) and the password.
   2. On "Passkey Registration", choose the phone. The computer shows a QR code.
   3. Scan it with the phone (Bluetooth on, the phone online). The phone keeps the passkey.
   4. The account page opens.
5. **Then on the phone itself:** the same link, the number, the password, the phone's own passkey. In the account
   console, Signing in shows one passkey.
6. **Prove it:**
   - `status` still works (break-glass);
   - the ERP's own sign-in (`erp.gaiada.com`) asks for no passkey;
   - a third sign-in from a fresh browser with **no** phone nearby ends on "Passkey Error" (no passkey, no entry).
7. **Revert:** `bash keycloak-passkey-realm.sh revert <the BACKUP dir>`. The test client may stay; it can do nothing
   on its own.

## Step C — QA accounts and the owner (PID-5c)

- **A finding from PID-2h:** Keycloak binds flows to **clients, not people**. The owner cannot be "switched" alone.
  Binding `gaiada-ui` switches everyone who signs in to the ERP.
- So PID-5c is a live drive **through the test client**: the owner and the QA accounts. The QA accounts use software
  passkeys (PID-4a), so headless checks keep working.

## Step D — everyone (PID-5d)

**Gates:**
- PID-3a and 3b are live: high assurance only within 15 minutes of a passkey touch, and the ERP session follows
  remember-me.
- PID-4c (the lockout drill) has passed on sumopod.
- The notice has gone out.

```bash
RP_ID=erp.gaiada.com BIND=realm PHONE_REQUIRED=1 bash keycloak-passkey-realm.sh apply   # dry run first
```

- Everyone, at their next sign-in: a username and a phone number (VERIFY_PROFILE), then a passkey.
- "Forgot password?" comes back, proved with the passkey. The script refuses to turn it on unless the realm's theme is
  `gaiada`, so a reset always signs out the other devices (PID-D15).
- The amr mapper goes on `gaiada-ui` and `gaiada-platform`.
- **Revert:** `revert <the BACKUP dir>`. Passkeys stay; the next sign-in is password-only again.

## Traps

- **The order of executions is their priority**, and a priority shared by two executions gives no guaranteed order.
  The script names every priority and refuses a flow with ties. Found by PID-2h: the first version could leave ties.
- **`PHONE_REQUIRED=1` reaches everyone at once,** whatever `BIND` says. The profile is realm-wide, and VERIFY_PROFILE
  runs after any client's sign-in.
- A backup made before PID-2h has no client `login_theme`. The revert reads that as "no theme".
- After a theme was set, the realm's `loginTheme` can only go back to `""`, never to absent. Keycloak treats both as the
  default theme.
- `scripts/sso-login.sh` stops working for any account that must use a passkey (plan §6 risk 7) until PID-4a.
