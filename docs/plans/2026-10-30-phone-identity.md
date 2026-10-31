# Phone identity: username, phone, password and a passkey on the person's phone

**Status: IN PROGRESS (2026-10-30, second version).** The decision log is §3; every PID decision is ruled (PID-D14 and PID-D15 on 2026-10-30, after the PID-2 prototype).
Ticket prefix: **PID**. Board section: `TASKS.md` → "Phone identity". The first version (a WhatsApp code on every
new device) is superseded by PID-D7, and WhatsApp is not used at all (PID-D8).

## 1. The problem

The ERP cannot use email to tell who a person is.

- Most staff addresses are Google Workspace aliases. A reset email lands in someone else's inbox, so "Forgot
  password?" was turned off on 2026-10-15 (DW-7h, `infra/runbooks/keycloak-security-events.md`).
- IT hands out temporary passwords. Nobody can recover their own account.
- There is no real second factor. MFA is simulated for the dev stage (PV-D40). "Before real clients use the
  portal" waits on real MFA.

## 2. The design (owner, 2026-10-30)

| Moment | What happens |
|---|---|
| **Registration** | Invite only (PID-D2). The person sets a username, a phone number and a password. |
| **First sign-in** | After the password, the person **must create a passkey on their phone**. The phone becomes their key; the account is unusable until this is done. |
| **Every sign-in** | Username + password, then the passkey. With no passkey, the sign-in is **refused**. |
| **On a computer** | The computer shows a QR code; the person scans it with their phone. **Bluetooth** only checks that the phone is physically near the computer; the data goes through an encrypted internet relay run by Google or Apple. |
| **On the phone itself** | The passkey is on the device, so the person signs in on the phone directly. |
| **MFA** | The same passkey. Sensitive actions (bank details, approvals that need high assurance) ask for a fresh passkey touch. |
| **Forgot password** | Username, then the passkey, then a new password. No email, no WhatsApp, no IT. |
| **Next time** | A remembered device stays signed in for **7 days**. No password or passkey until then. |

**Cost: Rp0.** Passkeys are part of Android 9+ (Google Password Manager) and iOS 16+ (iCloud Keychain), and part of
Keycloak itself. No vendor, no per-message price, no SIM.

Two facts the owner should know:

- **A passkey proves the device, not the phone number.** The phone number is an identifier the person types, like
  an email address (PID-D8). It must be unique, but nothing proves the person owns that number.
- **Phone passkeys usually sync** to the person's Google or Apple account. A new phone on the same account still
  works, which makes a lost phone easy. But "only that one phone" is really "only that person's Google or Apple
  account". On phones we cannot force one single device. Without a passkey, the sign-in is still refused.

## 3. Decisions

| # | Ruling | By | Date |
|---|---|---|---|
| PID-D1 | ~~A WhatsApp check on a new device and every 30 days.~~ **Superseded by PID-D7** the same day. | owner | 2026-10-30 |
| PID-D2 | **Invite only.** IT creates staff accounts; staff invite clients and contributors. No open sign-up page. | owner, chosen from options | 2026-10-30 |
| PID-D3 | ~~Which WhatsApp channel carries the sign-in proof.~~ **Moot:** WhatsApp is not used for sign-in (PID-D7). It is used only if PID-D8 proves the number. | — | 2026-10-30 |
| PID-D4 | Where it lives: **in Keycloak.** Passkeys, remember-me and the reset flow are built in after the upgrade. **One small extension** is needed because Keycloak only signs people in by username or email: a sign-in form that also finds the person by phone (PID-D9). One place for the ERP, the portal and WebDesk, and it fills the `amr` claim the platform already reads. | owner, agreed to the recommendation | 2026-10-30 |
| PID-D5 | ~~May two accounts share one phone?~~ **Settled by PID-D8:** one number per account. | — | 2026-10-30 |
| PID-D6 | ~~A grace period before existing accounts must add a phone.~~ **Withdrawn with the first version:** existing people add their phone and create their passkey at their next sign-in in their rollout wave (§7), after a notice. | — | 2026-10-30 |
| PID-D7 | **Username + phone + password, plus a passkey on the person's phone** as the second factor and the MFA; created at first sign-in; no passkey, no entry; "Forgot password?" proved with the passkey; a remembered device stays signed in for a week (§2). | owner | 2026-10-30 |
| PID-D8 | **No WhatsApp. The phone number is an identifier, like email:** one number per account, usable to sign in, not proved. "Forgot password?" uses the passkey on the phone. | owner | 2026-10-30 |
| PID-D9 | At sign-in the person types **username or phone, then the password**, then uses the passkey. | owner, chosen from options | 2026-10-30 |
| PID-D10 | The 7-day memory applies **only when the person ticks "This is my own device"**. Otherwise the session ends as today (10 h). Either way, sensitive actions need a fresh passkey touch. | owner, chosen from options | 2026-10-30 |
| PID-D11 | Lost phone: **IT, the superadmin or the owner** resets the person's sign-in. The person then signs in again and creates a new passkey, the same as when they registered. Defaults added by Claude, which the owner may change: nobody resets their own account this way; IT cannot reset the superadmin's or the owner's account (only the superadmin or the owner can); IT checks it is really the person (in person, or a video call) before the reset. | owner | 2026-10-30 |
| PID-D12 | **Clients and contributors too**, in the last rollout wave, before real client data. It is the real MFA that PV-D45 waits for. | owner, agreed to the recommendation | 2026-10-30 |
| PID-D13 | **A second passkey is offered at enrolment, not required:** a laptop's Windows Hello or Touch ID, or a security key. | owner, agreed to the recommendation | 2026-10-30 |
| PID-D14 | **A person may delete their own passkey** in the account console (Keycloak's `delete_credential` stays enabled). Chosen against the recommendation ("no, only IT resets"); the owner accepts §6 risk 17. | owner, chosen from options | 2026-10-30 |
| PID-D15 | **A password reset always signs out the other devices**, by a login-theme override in the PID-2h image (§6 risk 18). Until it ships, "Forgot password?" stays off for everyone. | owner, chosen from options | 2026-10-30 |

## 4. What exists today (measured on `origin/main` e3edaf9bf, 2026-10-30)

- **Keycloak 26.0**, stock image (`quay.io/keycloak/keycloak:26.0`), with no theme and no extensions.
  - Passkeys arrived in Keycloak **26.3** (the "Enable Passkeys" switch) and became officially supported in
    **26.4** (conditional and modal UI). 26.4 also adds "Condition - credential", which skips a second factor
    when the passkey was the first. 26.0 has only plain WebAuthn as a second factor.
  - So **an upgrade is a prerequisite**.
- **Live Keycloak, measured read-only 2026-10-30 (PID-1a,** one admin-API login inside the container, GETs only):
  - **26.0.8**, image `quay.io/keycloak/keycloak:26.0`, running since 2026-10-11. Its database is
    `gaiada_keycloak` on the host Postgres. Public address `KC_HOSTNAME=https://erp.gaiada.com/idp`, so the passkey
    RP ID defaults to `erp.gaiada.com`; the WebAuthn RP ID fields are empty today.
  - **75 accounts, all enabled. Every one holds only a password** (no OTP, no WebAuthn), and **every username equals
    the email.**
  - `loginWithEmailAllowed: true`, `registrationAllowed: false`, `resetPasswordAllowed: false`,
    `editUsernameAllowed: false`, `verifyEmail: true`.
  - `ssoSessionIdleTimeout` and `ssoSessionMaxLifespan` are 36000 (10 h). `rememberMe: false`, and both remember-me
    lifespans are 0.
  - **`bruteForceProtected: false`: nothing slows down password guessing today** (§6, risk 13).
  - Flows are all the built-in ones, with no client overrides. The `browser` flow is cookie, IdP redirector,
    Organization, then username-password with a conditional OTP. The `reset credentials` flow sends the reset email,
    unused while the reset is off.
  - Required actions: `CONFIGURE_TOTP`, `VERIFY_EMAIL`, `UPDATE_PASSWORD` (enabled), `delete_account` (disabled).
    **No WebAuthn registration action is enabled yet.**
  - User profile: `username`, `email`, `firstName`, `lastName`. **No phone attribute**, and unmanaged attributes
    are off.
  - Clients: `gaiada-ui` (public, standard flow), `gaiada-platform`, the service-account clients
    `gaiada-provisioner` and `webdesk-control`, and Keycloak's own. Direct grants are on only for `admin-cli`.
  - No `amr` mapper: `infra/runbooks/enable-mfa.md` is PLANNED, not applied.
- **The upgrade rehearsal (PID-1b, 2026-10-30, DEV-VERIFIED on sumopod): PASS.**
  - Script: `infra/scripts/keycloak-upgrade-rehearsal.sh`. A copy of the live database (`pg_dump` by the owner) was
    restored on an internal docker network; the copy was shredded afterwards.
  - Path: 26.0.8 → 26.8.1 → revert. The schema migrated in about 7 s.
  - Realm, flows, clients, all 75 accounts and their credentials came through identical, as did both service
    accounts (provisioner list-users 200, `webdesk-control` 403, before and after). The only difference: the migration
    adds the built-in required action `idp_link`.
  - Password logins and the passkeys switch work. The revert is identical.
  - The live procedure, the upgrade notes that matter and the revert are in `infra/runbooks/keycloak-upgrade.md`.
- **Usernames:** only `platform-nest/src/auth/oidc.ts` reads `preferred_username`, and only as a fallback display
  name. Identity is `sub` plus the verified email, so usernames can differ from emails safely (§6, risk 14).
- **The ERP's own session** is 12 h absolute (`platform-ui/src/lib/session.ts` `SESSION_TTL_SECONDS`).
- **Assurance:**
  - `platform-nest/src/auth/oidc.ts` maps an `amr` containing `mfa`/`otp`/`hwk`/`totp` to `high`.
  - It does **not** look at `auth_time`, so with a 7-day session an `amr` would claim "high" for a week (§6, risk 6).
  - `auth/step-up.controller.ts` holds the session-bound high slot with `assuranceSource` (only `simulated` today).
- **Account creation:**
  - Clients: `platform-ui/src/app/invite/[token]` + `POST /api/invites/accept`.
  - Contributors: `/contributor-invite/[token]` + `POST /api/editorial-invites/accept`.
  - Staff: IT Accounts provisions through `gaiada-provisioner` (`platform-nest/src/core/keycloak-admin.ts`) with a temporary password.
- **Test logins:** `scripts/sso-login.sh` drives the real PKCE flow with a password only. It stops working the moment a
  passkey is required (§6, risk 7).
- **WebDesk's API** checks Keycloak tokens itself (`webdesk/api/src/control/auth/keycloak-token-verifier.ts`). It
  inherits the passkey because Keycloak does the check, but it needs the same assurance rule.

## 5. How it is built (built-in Keycloak, plus one small extension for phone sign-in)

**Steps 2 to 8 are one script and one image, PROTOTYPED and DEV-VERIFIED on sumopod** (PID-2 2026-10-30; the phone
form and the theme, PID-2h, 2026-10-31): `infra/scripts/keycloak-passkey-realm.sh` (`apply [--dry-run]`,
`revert <backup>`, `status`) and the gaiada-keycloak image (`keycloak/`). The live order is
`infra/runbooks/keycloak-passkey-rollout.md` (PID-2g).
- **Proof:** `keycloak-passkey-realm-test.sh all` with the Playwright suite `keycloak-passkey-realm.e2e.cjs`. A Chrome
  virtual authenticator stands in for the phone. The test realm is upgraded from 26.0.8 to 26.8.1, like live.
  - dry run wrote nothing;
  - apply, and a second apply that changed nothing;
  - end-to-end **32/32**;
  - revert identical to before;
  - kcadm signed in with the container's own admin, with no password on the host (the live way).
- **The script takes `RP_ID` and `BIND`.** On live, `BIND=client:<test client>` comes first (§6 risk 1);
  `BIND=realm` switches everyone over.
  - With `BIND=client:…`, the flow and the theme go on that client only.
  - `PHONE_REQUIRED=0` keeps the profile change invisible: nobody is asked for a number, and VERIFY_PROFILE and
    `editUsernameAllowed` are left alone. The profile is realm-wide, so a required number would reach everyone
    through any client (§6 risk 20).
  - Proved (PID-2h): only the test client changed; another client kept the stock form, theme and sign-in; the revert
    of that apply was identical.

1. **Upgrade** Keycloak 26.0 to the newest 26.x patch at the time (26.4 or later), after a rehearsal on sumopod.
2. **User profile:**
   - `username`: chosen by the person (`editUsernameAllowed`). **The 3-to-30-character rule waits for PID-3c.** With
     today's usernames (every one is an email), the rule made Keycloak refuse the platform's own admin writes (create,
     disable, required actions: 400). That would break IT Accounts and the provisioner.
   - `phoneNumber`: required, stored as `+62…` (the profile validates only that form). **`08…` → `+62…` conversion
     belongs to the invite and IT screens (PID-3c) and the phone sign-in form (PID-2h);** Keycloak's profile cannot
     convert.
   - Existing people are asked for a username and phone at their next sign-in. Keycloak does this itself once
     the field is required.
   - **Uniqueness:** Keycloak does not enforce unique attributes. Our invite and IT screens refuse a number already
     in use, and a nightly check reports duplicates.
3. **Phone sign-in extension** (the only custom code; PID-D9). **DEV-VERIFIED on sumopod, PID-2h (2026-10-31).**
   - `gaiada-phone-username-password-form`: Keycloak's own Username Password Form. A username or an email goes to the
     stock code. A phone-shaped entry (08…, 62…, +62…, with spaces, dots or dashes) is converted to `+62…` and looked
     up in `phoneNumber`. The stock checks then run in the stock order.
   - **Fail-closed:** a number two accounts hold, or a number that is one account's phone and another account's
     username, names nobody. Every refusal is the same "Invalid username, phone number or password.".
   - **The brute-force trap it closes:** Keycloak counts a failed password against the account it finds from the
     attempted-username note, by username or email. With the typed number in that note, guesses by phone would never
     lock anyone out. The form puts the account's username there once the number matches. Proved: one wrong password
     by number raised the account's failure count; three locked it, also for sign-in by email.
   - **The theme** (`gaiada`, keycloak.v2 + three texts and one template) makes the field "Username or phone number".
     It makes a new password always sign out the other devices (§6 risk 18). A locked account reads exactly like a
     wrong password.
   - It ships as the gaiada-keycloak image: `FROM` the pinned Keycloak tag + the jar + the theme. The Dockerfile runs
     the unit tests.
     - `ci.yml` job `keycloak` runs the tests, checks the theme template against upstream, and builds the image.
     - `keycloak-image.yml` pushes and signs it on main as `gaiada-keycloak:<version>-<tree of keycloak/>`.
     - It is not in `release.yml`: a per-release tag would restart Keycloak at every release.
   - Every Keycloak upgrade rebuilds and re-tests it.
   - **Revert:** `STEPS=browser LOGIN_FORM=auth-username-password-form`. That puts the stock form back (proved: sign-in
     by number stops, username and email go on), with the passkey step and the amr references re-made.
   - **Rejected:** a community phone plugin (more than we need, and a new vendor). Also rejected: having our
     `/login` turn a phone into a username, which would show anyone whose username belongs to a number.
4. **Passkey policy:**
   - user verification required (fingerprint, face or phone PIN);
   - discoverable credential;
   - attestation "none";
   - **RP ID fixed to `erp.gaiada.com`** before anyone enrols. A passkey only works for its RP ID, so changing the ERP's
     domain or the RP ID later breaks every passkey. `api.erp.gaiada.com` is a subdomain, so WebDesk is covered.
5. **A new browser flow** `gaiada-passkey-browser` (a copy; the built-in one is never edited in place):
   - username or phone + password REQUIRED → passkey (WebAuthn) REQUIRED. The copy's conditional OTP subflow is removed;
     nobody holds OTP.
   - **`amr` references with a maxAge:** `pwd` 7 days, `hwk` 900 s. **26.8.1 reads a missing maxAge as 0 s**, so a step
     shows in `amr` only at the instant of sign-in (proved: `hwk` was gone on a refresh 5 s later).
   - First sign-in with no passkey goes to the "register passkey" required action, which has no skip. Proved: an
     abandoned registration gets no code, in the same browser or a fresh one.
   - **Proved:** with no passkey the sign-in ends on "Passkey Error", with no code and no "try another way".
6. **A new reset-credentials flow** `gaiada-passkey-reset`: choose user → **[passkey | else Deny access]** → set a new
   password.
   - **A naive version is a takeover hole, proved on 26.8.1** (§6 risk 16). Keycloak skips a REQUIRED step the person
     has not set up. With "choose user → passkey REQUIRED → reset password", a stranger who typed the username of an
     account with no passkey set its password, enrolled their own passkey and signed in.
   - **The fix uses built-ins only:** a REQUIRED subflow [WebAuthn ALTERNATIVE | Deny access ALTERNATIVE]. An account
     with no passkey, and an unknown name, both get the same "This account cannot reset its password here. Ask IT to
     reset your sign-in." That leaves nothing to enumerate.
   - `resetPasswordAllowed` comes back **only** with this flow bound, never with the email one.
   - **Other sessions do NOT end on their own with Keycloak's own page** (§6 risk 18). Its "Sign out from other
     devices" box is unticked by default.
     - The gaiada theme (PID-2h) sends `logout-sessions=on` instead. Proved: a reset ended the remembered 7-day session
       on another browser.
     - The script turns `resetPasswordAllowed` on only when the realm's login theme is `gaiada` (PID-D15).
7. **Remember me** (PID-D10): the sign-in form gets a "This is my own device" box, which is Keycloak's remember-me,
   reworded. The remember-me lifespans are 7 days. Unticked sessions keep today's 10 h. The ERP's own session
   follows: 7 days when remembered, 12 h otherwise.
8. **The `amr` mapper** (`oidc-amr-mapper`) on `gaiada-ui` and `gaiada-platform`, with the step-5 references. Proved:
   `["pwd","hwk"]` after a passkey sign-in, `["pwd"]` once the passkey use is older than its maxAge.
9. **Platform (PID-3a):**
   - "High" requires **`hwk` in `amr` AND `auth_time` within 15 minutes**. `hwk`'s maxAge only stops new tokens; an
     access token minted at minute 14 still lives 60 min (`accessTokenLifespan` 3600). Proved: a remembered session
     keeps the original `auth_time`.
   - The step-up page sends the person back to Keycloak with `max_age=0` for a fresh touch. This replaces the
     simulated button once live.
10. **Brute force (PID-2i):**
    - **Settings:** temporary lockouts only (5 failures, 60 s step, 900 s max); `maxSecondaryAuthFailures` **0**.
    - **Why 0:** a positive value locks permanently even in temporary mode. Measured on 26.8.1: failed passkey checks
      are not counted at all, so a positive value would only ever bite OTP.
    - **Proved:** a lockout recovers on its own, and `user.enabled` stays true.
    - The script can apply this step alone (`STEPS=bruteforce`) as the early live step.

## 6. Risks and their controls ("plan this safely")

| # | Risk | Control |
|---|---|---|
| 1 | **A flow change locks everyone out, the owner included.** | Built and proved on sumopod first. On live, the new flow is bound first to a **test client only**, and the owner enrols before any user is switched. The Keycloak bootstrap admin in the master realm (kcadm inside the container, proved 2026-10-15) is the break-glass. It never goes through the new flow, and it is checked to work before each step. Every live step: realm backup, one change, a test sign-in, a written revert. |
| 2 | **The upgrade changes Keycloak's database**, and only a restore undoes it. | Full Keycloak DB dump first. Rehearsal on sumopod with a copy of live's realm; the copy holds password hashes, so it stays on the servers and never goes in the repo. A maintenance window. Revert = restore the dump + the old image tag. |
| 3 | **Whoever uses an invite first creates the passkey** (trust on first use). | Invites are single use and expire in 72 h. Staff temporary passwords are handed over by IT in person. The person sees "passkey created on <device>, <time>", and IT Accounts shows it. An invite that is "already used" sends the real person to IT, who revokes it. |
| 4 | **Recovery is the weak point** (attackers call the help desk). | No self-service recovery without a passkey, by design. "Reset sign-in" per PID-D11, done by IT, the superadmin or the owner: <br>• it removes every passkey, ends every session and sets a one-time temporary password, handed over to the person directly; <br>• the next sign-in makes the person set a new password and a new passkey, as at registration; <br>• whoever resets first checks it is really the person; <br>• nobody resets their own account; IT cannot reset the superadmin or the owner; <br>• audit row, and the person sees "your sign-in was reset by <name>" at their next sign-in. <br>Encourage a second passkey (PID-D13). |
| 5 | **A 7-day session on a shared office computer.** | Opt-in "This is my own device" (PID-D10). Sensitive actions always need a fresh touch. "Sign out everywhere" for the person, and IT can end someone's sessions (the D11 `session_version`). |
| 6 | **"Remembered" turns into "high assurance" for a week.** | High only within 15 min of a passkey touch (§5.9), proved by a test in which a remembered session is refused `set_bank_details`. |
| 7 | **Headless tests and live checks stop working** (`sso-login.sh` is password-only). | A test-only software passkey for QA and placeholder accounts: a virtual authenticator in Playwright (Chrome DevTools), plus a small soft-key helper for `sso-login.sh`. Keys live in `CREDENTIALS.local.md`. Re-checked when real data arrives (the standing seed ruling). |
| 8 | **Computers without Bluetooth, or older systems.** | Sign in on the phone itself; a USB Bluetooth adapter; or a second passkey on the laptop (Windows Hello / Touch ID). A device check is part of the proof (§8, PID-4). |
| 9 | **The phone has no screen lock or is offline.** | Passkeys require a screen lock. The cross-device step needs the phone online with Bluetooth on. The first-sign-in screen says both, in plain words. |
| 10 | **Bots and services break.** | They never use the browser flow (client credentials, service tokens), so they are unaffected. The proof includes a check that each one still works. |
| 11 | **Custom code inside the identity provider** (the phone sign-in extension). | Kept to one form and one lookup (§5.3). It fails closed on a shared number and on a number that is another account's username, and gives the same message for every failure, a lockout included. It keeps brute-force detection working for sign-in by number (proved). Tests run in CI, the image is pinned and named by its contents, and it is rebuilt and re-tested at every Keycloak upgrade (the theme template is checked against upstream). If it ever fails, the script puts the stock form back (`LOGIN_FORM=auth-username-password-form`, proved): username and email sign-in go on. |
| 12 | **The phone number is not proved** (PID-D8). Someone could register another person's number, or mistype their own. | Invite only, so only invited people can register. A number already in use is refused. IT can correct a number on the IT Accounts page (audited). Nobody gets access through a number: they still need the password and the passkey. |
| 13 | **Brute-force protection is off on live** (measured 2026-10-30). Username or phone + password can be guessed with no slow-down. The passkey stops a guessed password from getting in, but only once it is required. | Turn on Keycloak's brute-force detection with **temporary** lockouts (never permanent: a permanent lockout of the owner is itself a lockout incident), in the first live realm step (PID-2i). Every headless test login stays a single attempt, as already ruled. |
| 14 | **Usernames have always equalled emails** (all 75 live accounts). | Only one reader of `preferred_username` exists (a fallback display name). The proof checks that the IT Accounts page, the invite adoption (`findUserByEmail` with `exact=true`) and `sso-login.sh` all key on email or `sub`, never on the username. |
| 15 | **The image bump upgrades live in whichever release carries it.** `deploy.yml`'s `up -d` recreates Keycloak, because the `auth` profile is deployed. Keycloak has no down-migration. | The compose change stays on its own branch until the owner picks a window. The backup (runbook §1) is taken first; then it rides a train **alone**. Revert = restore the dump **and** the old tag together. Never re-run an older release's deploy job afterwards (it would start 26.0 on the migrated database); `rollback-to.sh` is safe. |
| 16 | **"Forgot password?" takes over an account that has no passkey** (proved on 26.8.1: Keycloak skips a REQUIRED step the person has not set up, so a naive reset flow let a stranger set the password and enrol their own passkey). | The reset flow's proof step is [passkey | else Deny access] (§5.6). An account without a passkey and an unknown name get the same refusal. The e2e suite keeps both the naive-flow observation (d0) and the refusal (d2), so a later Keycloak or flow change cannot reopen it unseen. |
| 17 | **A person can delete their only passkey** in the account console (Keycloak's `delete_credential` action is enabled after the upgrade). Their next sign-in then enrols a new passkey with the password alone, so anyone holding the password and a session could swap the passkey. | **Accepted by the owner (PID-D14, 2026-10-30): self-service deletion stays.** What limits it: deleting needs a signed-in session, which already needs the passkey; the re-enrolment that follows still needs the password. What is still missing: live records only LOGIN, LOGIN_ERROR and LOGOUT (DW-7h), so a removed or added passkey leaves no event today; PID-3d adds the credential events (`REMOVE_CREDENTIAL`, `UPDATE_CREDENTIAL`) and shows them on IT's pages. Revisit before real client data. |
| 18 | **A password reset leaves the other signed-in devices signed in** (Keycloak's "Sign out from other devices" box is unticked by default, and the theme cannot be configured otherwise). A remembered 7-day session on a lost or stolen device would survive the reset. | **Ruled PID-D15 (owner, 2026-10-30): always.** The gaiada theme (PID-2h) replaces the box with a hidden `logout-sessions=on`. Proved: the remembered session on another browser ended at the reset. The script turns "Forgot password?" on only with that theme on the realm. IT's "Reset sign-in" ends every session (PID-3d). Limit: it is the page that sends the field, so a hand-made request could leave it out, and only the person who just passed the passkey check can make one. |
| 19 | **A flow's steps run in no guaranteed order.** Found by PID-2h in Keycloak 26.8.1's source: editing an execution resets its priority to the one in the request (0 when absent), and executions with the same priority run in database-row order. The first version of the script could leave ties, so the order it was proved in was luck. | Every execution the script writes gets an explicit priority (10, 20, 30…). The script refuses a flow of ours that holds a tie. Live never had the flows (only brute force was applied), so nothing live is affected. |
| 20 | **A realm-wide step reaches everyone during the test-client phase.** Keycloak binds flows to clients, not people, but the user profile and its required-field check are realm-wide. A required phone number would ask every person at their next sign-in, through any client. | `PHONE_REQUIRED=0` for PID-5b and 5c: the number exists but nobody is asked. The owner and QA drive the new sign-in through the test client (there is no per-person switch). `PHONE_REQUIRED=1` comes with `BIND=realm` at the staff wave. |

## 7. Rollout order

1. sumopod: the upgrade rehearsal and every flow.
2. Live upgrade (owner approves the window).
3. Live flows bound to a test client; **the owner enrols**; break-glass proved.
4. QA accounts (with software passkeys) and the owner drive the new sign-in through the test client. Keycloak binds
   flows to clients, not people, so nobody can be switched alone (§6 risk 20).
5. Staff, in one wave, after a notice. Each person enrols at their next sign-in.
6. Contributors, then clients (PID-D12).
7. MFA simulation off. That is the "Before real clients use the portal" line, coordinated, not done here.

## 8. Phases and tickets

**PID-0 · Decisions:** 0a the plan + PID-D2, D7 to D11 recorded in the repo; 0b PID-D4, D12, D13 ruled and recorded.

**PID-1 · Keycloak upgrade:**
- 1a measure live read-only: version, flows, realm settings, session lengths, how many people hold which credentials;
- 1b rehearse 26.0 to 26.x on sumopod with a copy of live's realm, including the revert;
- 1c live upgrade with a DB dump, a window and a revert (owner approves).

**PID-2 · Realm setup, on sumopod:**
PROTOTYPED and DEV-VERIFIED on sumopod: 2026-10-30, and 2h on 2026-10-31 (§5, script
`infra/scripts/keycloak-passkey-realm.sh`, image `keycloak/`). 2g is the live runbook,
`infra/runbooks/keycloak-passkey-rollout.md`.
- 2a user profile (username rules, phone number in one form; existing people asked at next sign-in);
- 2h the phone sign-in extension and the Keycloak image built in CI (§5.3);
- 2b passkey policy with the fixed RP ID;
- 2c the new browser flow + the required "register passkey" action;
- 2d the passkey-based reset flow;
- 2e "This is my own device" = remember-me, 7 days;
- 2f the `amr` mapper;
- 2i brute-force detection on, temporary lockouts only (§6 risk 13); offered to the owner as an early live step
  ahead of the rest, since it closes a gap that exists today;
- 2g all of it as a script with backup and revert, in `infra/runbooks/`.

**PID-3 · Platform:**
- 3a high assurance only within 15 min of a passkey (`auth_time`), step-up through Keycloak with `max_age=0`;
- 3b the ERP session follows remember-me;
- 3c the invite screens ask for username + phone (a number in use is refused); a nightly duplicate check;
- 3d IT Accounts: passkeys (count, device, last used), phone (correctable, audited), end sessions, and "Reset
  sign-in" per PID-D11 (§6 risk 4);
- 3e WebDesk's API uses the same assurance rule.

**PID-4 · Proof (sumopod):**
- 4a the software passkey for tests (Playwright + `sso-login.sh`);
- 4b e2e: invite → first sign-in enrolment; sign-in by username and by phone, with and without a passkey (refused);
  a duplicated number refused; forgot password; "my own device" ticked and unticked, and the 7-day expiry; a
  remembered session refused a sensitive action; reset sign-in by IT, refused for IT on the owner; bots unaffected;
- 4c a lockout drill: the new flow broken on purpose, recovered with the break-glass in the runbook's time;
- 4d devices: Android + Chrome, iPhone + Safari, Windows 11 with and without Bluetooth, Mac;
- 4e axe, light and dark, desktop and phone, on every new screen.

**PID-5 · Live rollout:**
- 5a the live upgrade done and checked;
- 5b flows on the test client, the owner enrolled, break-glass proved;
- 5c QA accounts + the owner on the test client; a live drive;
- 5d staff wave;
- 5e contributors and clients (PID-D12).
